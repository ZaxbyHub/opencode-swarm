// Contract (issue #3311 AC7): a verdict-lane owner that settled terminal
// with the typed 'contract' failure class is TYPED-DEAD terminality evidence
// for N-of-M verdict settlement once the per-item budget is exhausted.
// RED at base, GREEN after the fix: at base the owner arm admits only
// liveness-class terminals, so this budget-exhausted all-contract world is
// refused with "item ... still has a non-liveness-terminal owner lane ...";
// after the fix the admission succeeds and the receipt item carries the TRUE
// class ('verdict_contract'), not the liveness literal. The admission-false
// base arm is already pinned by verdict-settlement-admission-arms.test.ts, so
// this file asserts the post-fix truth only.

import { beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { deriveVerdictSettlementAdmission } from '../../../src/pr-review/verdict-settlement.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const HEAD = 'abc123';
const LANE_ID = 'vc-owner-lane';
const ITEM = 'c1';
const BATCHES = ['vc-b1', 'vc-b2', 'vc-b3'];

let directory = '';

/** Seed one error+contract terminal owner record for the given batch. */
async function seedContractDeadOwner(batchId: string): Promise<void> {
	const correlationId = `${batchId}-${LANE_ID}-seed`;
	const reason = `contract violation on lane ${LANE_ID} (${batchId})`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'vc-session',
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
		status: 'error',
		result: {
			error: reason,
			chars: reason.length,
			truncated: false,
			digest: createHash('sha256').update(reason).digest('hex'),
			workflowLaneFailureClass: 'contract',
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
	directory = canonicalMkdtemp('verdict-contract-terminal-');
});

describe('issue #3311 AC7: contract-typed verdict-lane terminals', () => {
	test('three error+contract owners exhaust the budget and admit with the true class', async () => {
		for (const batchId of BATCHES) {
			await seedContractDeadOwner(batchId);
		}
		const admission = deriveVerdictSettlementAdmission({
			directory,
			prHeadSha: HEAD,
			phase: 'reviewer',
			window: budgetExhaustedWindow(),
			unclaimed: [ITEM],
		});
		expect(admission.admitted).toBe(true);
		expect(admission.items).toHaveLength(1);
		expect(admission.items[0]?.itemId).toBe(ITEM);
		// The disclosed evidence class is the TRUE class of the dead owners —
		// 'verdict_contract', never the hardcoded 'liveness' literal.
		expect(admission.items[0]?.evidenceClass).toBe('verdict_contract');
		expect(admission.items[0]?.terminalStatus).toBe('error');
	});
});
