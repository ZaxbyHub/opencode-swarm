// Contract (issue #3311 AC12, the AC13 default): an explicitly
// operator-cancelled verdict-lane owner is EXCLUDED from typed-dead
// terminality evidence — operator cancellation is a deliberate human act,
// never host abandonment, so a world whose non-liveness owner settled
// error+operator_cancelled never admits N-of-M settlement even with the
// full 1 + budget attempt set. GREEN at base and head: at base the owner arm
// refuses the non-liveness-terminal operator-cancelled record; after the
// fix the widened typed-dead admission deliberately keeps operator_cancelled
// out (the AC13 default decision — an excluded class), so settlement keeps
// blocking.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { deriveVerdictSettlementAdmission } from '../../../src/pr-review/verdict-settlement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD = 'abc123';
const LANE_ID = 'oc-owner-lane';
const ITEM = 'c1';
const OPERATOR_BATCH = 'oc-b1';
const LIVENESS_BATCHES = ['oc-b2', 'oc-b3'];
const ALL_BATCHES = [OPERATOR_BATCH, ...LIVENESS_BATCHES];

let directory = '';

interface SeedArgs {
	batchId: string;
	status: 'error' | 'stale';
	failureClass: 'operator_cancelled' | 'liveness';
}

async function seedOwnerRecord({
	batchId,
	status,
	failureClass,
}: SeedArgs): Promise<void> {
	const correlationId = `${batchId}-${LANE_ID}-seed`;
	const reason = `seeded ${failureClass} owner lane ${LANE_ID} (${batchId})`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'oc-session',
		callID: `${batchId}-${LANE_ID}-call`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: LANE_ID,
		mode: 'swarm-pr-review:reviewer',
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: LANE_ID,
		workspace: {
			directory,
			gitHead: HEAD,
			dirtyHash: null,
			prHeadSha: HEAD,
			scope: null,
		},
	});
	await appendDelegationTransition(directory, correlationId, {
		status,
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			workflowLaneFailureClass: failureClass,
		},
	});
}

/** One lane owning ITEM across 1 + PR_REVIEW_VERDICT_RETRY_BUDGET batches. */
function budgetExhaustedWindow() {
	return ALL_BATCHES.map((batchId) => ({
		batchId,
		lanes: [
			{
				laneId: LANE_ID,
				workflowLane: LANE_ID,
				reviewItemIds: [ITEM],
			},
		],
	}));
}

beforeEach(() => {
	directory = canonicalMkdtemp('verdict-settlement-operator-');
});

describe('issue #3311 AC12: operator_cancelled owners stay excluded', () => {
	test('an operator-cancelled owner plus liveness-dead retries never admits (AC13 default)', async () => {
		await seedOwnerRecord({
			batchId: OPERATOR_BATCH,
			status: 'error',
			failureClass: 'operator_cancelled',
		});
		for (const batchId of LIVENESS_BATCHES) {
			await seedOwnerRecord({
				batchId,
				status: 'stale',
				failureClass: 'liveness',
			});
		}
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: budgetExhaustedWindow(),
			unclaimed: [ITEM],
		});
		expect(admission.admitted).toBe(false);
		// Reason wording may evolve across the fix; the durable claim is that
		// the operator-cancelled owner lane is named as the blocking cause.
		expect(admission.reason).toMatch(/owner lane/);
		expect(admission.items).toEqual([]);
	});
});
