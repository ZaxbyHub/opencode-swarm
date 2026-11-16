// Contract (issue #3311 AC10): an unclaimed item whose every owner settled
// 'completed' (unclaiming, classless) is NEVER admissible for N-of-M verdict
// settlement — even after the budget arm's required attempts exist — because
// the receipt row must cite a typed-dead source batch/lane, and no typed-dead
// owner exists in this world. GREEN at base and head: at base the owner arm
// refuses the non-liveness-terminal completed record; after the fix the
// completed owners keep consuming attempts but still provide no typed-dead
// source, so settlement keeps blocking (silence of the class is not evidence).

import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { deriveVerdictSettlementAdmission } from '../../../src/pr-review/verdict-settlement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD = 'abc123';
const LANE_ID = 'nt-owner-lane';
const ITEM = 'c1';
const BATCHES = ['nt-b1', 'nt-b2', 'nt-b3'];

let directory = '';

/** Seed one classless completed (unclaiming) owner record for the batch. */
async function seedCompletedOwner(batchId: string): Promise<void> {
	const correlationId = `${batchId}-${LANE_ID}-seed`;
	const reason = `completed without a claim on lane ${LANE_ID} (${batchId})`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'nt-session',
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
		status: 'completed',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
		},
	});
}

/** 1 + PR_REVIEW_VERDICT_RETRY_BUDGET (= 3) distinct owner batches for ITEM. */
function budgetExhaustedWindow() {
	return BATCHES.map((batchId) => ({
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
	directory = canonicalMkdtemp('verdict-settlement-no-typed-');
});

describe('issue #3311 AC10: no typed-dead owner keeps settlement blocked', () => {
	test('three completed classless owners never admit, budget or not', async () => {
		for (const batchId of BATCHES) {
			await seedCompletedOwner(batchId);
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
		// an owner lane is named as the blocking cause (no typed-dead source).
		expect(admission.reason).toMatch(/owner lane/);
		expect(admission.items).toEqual([]);
	});
});
