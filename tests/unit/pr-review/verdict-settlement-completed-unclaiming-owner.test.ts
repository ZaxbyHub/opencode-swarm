// Contract (issue #3311 AC9): a 'completed' (unclaiming, classless) owner
// lane CONSUMES one per-item verdict attempt: a world with one completed
// owner plus 1 + budget - 1 liveness-dead owners satisfies the per-item
// budget and admits N-of-M settlement. RED at base, GREEN after the fix:
// at base the owner arm refuses the completed record with "item ... still
// has a non-liveness-terminal owner lane ...", so admitted=false; after the
// fix the completed owner counts toward the budget (admitted=true would be
// unreachable otherwise — only two liveness attempts exist) and the receipt
// row cites a typed-dead (liveness) source batch, never the completed one.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { deriveVerdictSettlementAdmission } from '../../../src/pr-review/verdict-settlement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD = 'abc123';
const LANE_ID = 'cu-owner-lane';
const ITEM = 'c1';
const COMPLETED_BATCH = 'cu-b1';
const LIVENESS_BATCHES = ['cu-b2', 'cu-b3'];
const ALL_BATCHES = [COMPLETED_BATCH, ...LIVENESS_BATCHES];

let directory = '';

interface SeedArgs {
	batchId: string;
	status: 'error' | 'stale' | 'completed';
	failureClass?: 'liveness';
}

async function seedOwnerRecord({
	batchId,
	status,
	failureClass,
}: SeedArgs): Promise<void> {
	const correlationId = `${batchId}-${LANE_ID}-seed`;
	const reason = `seeded ${status} owner lane ${LANE_ID} (${batchId})`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'cu-session',
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
			...(failureClass ? { workflowLaneFailureClass: failureClass } : {}),
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
	directory = canonicalMkdtemp('verdict-settlement-completed-');
});

describe('issue #3311 AC9: completed owner consumes an attempt', () => {
	test('a completed owner plus two liveness-dead owners satisfies the budget and admits', async () => {
		await seedOwnerRecord({
			batchId: COMPLETED_BATCH,
			status: 'completed',
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
		// admitted=true is only reachable when the completed owner counted as
		// the third attempt: two liveness batches alone stay under the
		// 1 + budget = 3 required attempts.
		expect(admission.admitted).toBe(true);
		expect(admission.items).toHaveLength(1);
		expect(admission.items[0]?.itemId).toBe(ITEM);
		// The receipt row cites a typed-dead source batch/lane — the completed
		// owner is a consumed attempt, never the disclosed source.
		expect(LIVENESS_BATCHES).toContain(admission.items[0]?.sourceBatchId);
		expect(admission.items[0]?.sourceBatchId).not.toBe(COMPLETED_BATCH);
		expect(admission.items[0]?.evidenceClass).toBe('liveness');
		expect(admission.items[0]?.terminalStatus).toBe('stale');
	});
});
