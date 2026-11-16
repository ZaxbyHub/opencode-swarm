// Contract (issue #3311 AC15): when the dead reviewer lanes of an N-of-M
// verdict settlement are TYPED-dead (controller-written 'contract' class,
// not liveness) and the full 1 + budget = 3 attempt set exists, the real
// gate path settles: assertPrReviewValidationSettled resolves (no BLOCKED
// throw), the projected report is DEGRADED_DISCLOSED (APPROVE removed from
// the allowed verdict matrix), and NO reviewer/critic verdict is synthesized
// for the admitted items (they stay unclaimed; only the receipt discloses
// them). RED at base, GREEN after the fix: at base the owner arm refuses
// every contract-typed owner, so the gate throws the BLOCKED
// "items lack an authenticated verdict" error on the first await below.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
	readPrReviewVerdictSettlementEffectiveIds,
	recordPrReviewValidationBatch,
	resolvePrReviewWriterRunId,
} from '../../../src/hooks/pr-workflow-gate.js';
import { verdictSettlementDegradationActive } from '../../../src/pr-review/verdict-settlement.js';
import {
	HEAD_SHA,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';
import {
	DEAD_LANE,
	establishFullInventory,
	LIVE_LANE,
	reviewedRows,
} from './n-of-m-verdict-settlement.fixtures.js';

interface ContractDeadLaneArgs {
	batchId: string;
	laneId: string;
	phase: 'reviewer' | 'critic';
}

/**
 * The typed-dead twin of the fixtures' `seedLivenessDeadLane`: same durable
 * shape, but the controller-written class is 'contract' with terminal status
 * 'error' (the production producer's pair, dispatch-lanes.ts "contract"
 * settle) — typed-dead, never liveness.
 */
async function seedContractDeadLane({
	batchId,
	laneId,
	phase,
}: ContractDeadLaneArgs): Promise<void> {
	const correlationId = `${batchId}-${laneId}-session`;
	const reason = `lane ${laneId} violated its output contract (${batchId})`;
	await recordPendingDelegation(tempDir, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: `${batchId}-${laneId}-call`,
		normalizedAgent: phase,
		swarmPrefixedAgent: phase,
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId,
		mode: `swarm-pr-review:${phase}`,
		prReviewLegacyTranscriptCompatibility: true,
		workflowLane: laneId,
		workspace: {
			directory: tempDir,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	await appendDelegationTransition(tempDir, correlationId, {
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

/**
 * The establishDeadReviewerWorld shape with every dead-lane seed swapped to
 * seedContractDeadLane: initial batch (live lane + contract-dead lane, live
 * artifact persisted), then retry batches 2 and 3 re-declaring the dead
 * lane's items with a contract-dead lane each — the full 3-batch budget.
 */
async function establishContractDeadReviewerWorld(): Promise<{
	liveItems: string[];
	deadItems: string[];
}> {
	const ids = await establishFullInventory();
	const liveItems = ids.slice(0, Math.max(1, Math.floor(ids.length / 2)));
	const deadItems = ids.slice(liveItems.length);
	await recordPrReviewValidationBatch(
		tempDir,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: LIVE_LANE,
				workflowLane: LIVE_LANE,
				reviewItemIds: liveItems,
			},
			{
				laneId: DEAD_LANE,
				workflowLane: DEAD_LANE,
				reviewItemIds: deadItems,
			},
		],
		{ batchId: 'typed-batch-1', prHeadSha: HEAD_SHA },
	);
	await persistBatch(
		'typed-batch-1',
		'swarm-pr-review:reviewer',
		[{ laneId: LIVE_LANE, workflowLane: LIVE_LANE }],
		{ textOverride: reviewedRows(liveItems) },
	);
	await seedContractDeadLane({
		batchId: 'typed-batch-1',
		laneId: DEAD_LANE,
		phase: 'reviewer',
	});
	await resolvePrReviewWriterRunId(tempDir, SESSION_ID);
	for (const suffix of ['2', '3']) {
		const batchId = `typed-batch-${suffix}`;
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: DEAD_LANE,
					workflowLane: DEAD_LANE,
					reviewItemIds: deadItems,
				},
			],
			{ batchId, prHeadSha: HEAD_SHA },
		);
		await seedContractDeadLane({
			batchId,
			laneId: DEAD_LANE,
			phase: 'reviewer',
		});
	}
	return { liveItems, deadItems };
}

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('issue #3311 AC15: typed contract-dead settlement is downgrade-only', () => {
	test('the gate settles contract-dead lanes after the full budget; the report degrades and no verdict is synthesized', async () => {
		const { deadItems } = await establishContractDeadReviewerWorld();
		// At base this await rejects with the BLOCKED "items lack an
		// authenticated verdict" error; after the fix it resolves.
		await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		// Downgrade-only, per-item disclosure: the effective disclosed set is
		// exactly the contract-dead items.
		const effective = await readPrReviewVerdictSettlementEffectiveIds(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect([...effective].sort()).toEqual([...deadItems].sort());
		// No synthesized verdict: every admitted item stays unclaimed in the
		// reviewer composition (settlement discloses; it never fabricates a
		// reviewer row for a dead lane).
		const composed = (await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		)) as { claims: Map<string, unknown>; unclaimed: string[] };
		for (const item of deadItems) {
			expect(composed.claims.has(item)).toBe(false);
			expect(composed.unclaimed).toContain(item);
		}
		// DEGRADED_DISCLOSED: the report projection consults
		// verdictSettlementDegradationActive and removes APPROVE from the
		// allowed verdict matrix (REQUEST_CHANGES/INCOMPLETE remain).
		const runId = await resolvePrReviewWriterRunId(tempDir, SESSION_ID);
		const criticComposed = (await gateInternals.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'critic',
		)) as { unclaimed: string[] };
		expect(
			verdictSettlementDegradationActive({
				directory: tempDir,
				runId,
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION_DIGEST,
				reviewerUnclaimed: composed.unclaimed,
				criticUnclaimed: criticComposed.unclaimed,
			}),
		).toBe(true);
		const { readPrReviewTerminalCoverageForReport } = await import(
			'../../../src/pr-review/completion.js'
		);
		const report = await readPrReviewTerminalCoverageForReport(
			tempDir,
			SESSION_ID,
		);
		expect(report).not.toBeNull();
		expect(report?.allowedVerdicts).not.toContain('APPROVE');
		expect(report?.allowedVerdicts).toContain('REQUEST_CHANGES');
		expect(report?.allowedVerdicts).toContain('INCOMPLETE');
	});
});
