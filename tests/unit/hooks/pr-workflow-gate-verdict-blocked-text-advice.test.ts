import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	assertPrReviewValidationSettled,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishFullInventory,
	LIVE_LANE,
	reviewedRows,
} from '../pr-review/n-of-m-verdict-settlement.fixtures.js';
import {
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// ACCEPTANCE CHECK AC23 (DISCRIMINATING — RED at base, GREEN after the fix).
//
// Contract under test (FROZEN MESSAGE ADVICE): when the PR_REVIEW N-of-M
// verdict settlement BLOCKS because an unclaimed item's owner lane terminated
// with a NON-ADMISSIBLE class (here: the controller's own typed
// operator_cancelled record), the thrown BLOCKED message must
//   (a) NAME the blocking class — the message matches /operator_cancelled/ —
//       and
//   (b) NOT offer the liveness re-dispatch advice — the message does not
//       match /controller-observed liveness evidence/.
// Re-dispatching to "exhaust the retry budget with controller-observed
// liveness evidence" is the WRONG advice for an operator cancellation: the
// operator, not the host, killed the lane, and the honest recovery is an
// operator decision (re-dispatch deliberately, or complete downgrade-only).
//
// RED at base: the advice tail ("...re-dispatch the unclaimed items to
// exhaust the retry budget with controller-observed liveness evidence, or
// complete downgrade-only once admissible") is emitted UNCONDITIONALLY for
// every non-admitted reason, and the base message never names the blocking
// class. GREEN after the fix: class-specific guidance as pinned above.

const DEAD_LANE = 'ac23-operator-cancelled-lane';

/**
 * Seed an owner lane that terminated via the controller's own cancel path:
 * durable status 'cancelled' with the typed operator_cancelled class and no
 * retained artifact — the exact record shape cancel_pending produces. The
 * settlement admission must refuse it (a cancellation is the controller's own
 * act, not host abandonment) and say WHY.
 */
async function seedOperatorCancelledOwnerLane(args: {
	batchId: string;
	laneId: string;
}): Promise<void> {
	const { batchId, laneId } = args;
	const correlationId = `${batchId}-${laneId}-session`;
	const reason = `lane ${laneId} cancelled via cancel_lane_batch: ac23 fixture`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-${laneId}-call`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: 'swarm-pr-review:reviewer',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: 'complete PR diff def456...abc123',
		},
	});
	await appendDelegationTransition(tempDir, correlationId, {
		status: 'cancelled',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			workflowLaneFailureClass: 'operator_cancelled',
		},
	});
}

async function captureBlockedMessage(): Promise<string> {
	let message = '';
	try {
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	return message;
}

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('AC23: verdict-settlement BLOCKED text names the blocking class and drops liveness advice for operator cancellations', () => {
	test('an operator_cancelled owner produces class-specific guidance, not liveness-evidence advice', async () => {
		const ids = await establishFullInventory();
		const live = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
		const dead = ids.slice(live.length);
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{ laneId: LIVE_LANE, workflowLane: LIVE_LANE, reviewItemIds: live },
				{ laneId: DEAD_LANE, workflowLane: DEAD_LANE, reviewItemIds: dead },
			],
			{ batchId: 'ac23-batch-1', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'ac23-batch-1',
			'swarm-pr-review:reviewer',
			[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
			{ textOverride: reviewedRows(live) },
		);
		await seedOperatorCancelledOwnerLane({
			batchId: 'ac23-batch-1',
			laneId: DEAD_LANE,
		});
		const message = await captureBlockedMessage();
		// The gate did block, and the dead items are the named unclaimed ones.
		expect(message).not.toBe('');
		for (const itemId of dead) {
			expect(message).toContain(itemId);
		}
		// (a) RED at base: the base message never names the blocking class.
		expect(message).toMatch(/operator_cancelled/);
		// (b) RED at base: the liveness re-dispatch advice is unconditional.
		expect(message).not.toMatch(/controller-observed liveness evidence/);
	});
});
