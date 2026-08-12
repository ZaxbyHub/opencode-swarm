import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import {
	activatePrWorkflow,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { executeWritePrReviewTriggerEval } from '../../../src/tools/write-pr-review-trigger-eval.js';
import {
	HEAD_SHA,
	PR_REVIEW_BASE_SHA,
	PR_REVIEW_SCOPE,
	persistBatch,
	REVISION_DIGEST,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
let createdSessions = 0;

function triggerEvaluation(): PrReviewInlineTriggerRow[] {
	return PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
		trigger_id: triggerId,
		result: 'MATCHED' as const,
		evidence: `Changed behavior requires focused review for ${triggerId}`,
	}));
}

async function establishBaseCoverage(): Promise<void> {
	await activatePrWorkflow(tempDir, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(tempDir, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: PR_REVIEW_BASE_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: `base-${workflowLane}`,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(tempDir, SESSION_ID, baseLanes, {
		batchId: 'micro-cycle-base',
		prHeadSha: HEAD_SHA,
	});
	await persistBatch('micro-cycle-base', 'swarm-pr-review:base', baseLanes, {
		scope: PR_REVIEW_SCOPE,
	});
}

async function dispatchMicro(
	batchId: string,
	ledger: ReturnType<typeof triggerEvaluation>,
	workflowLane: string,
) {
	return executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:micro',
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: PR_REVIEW_BASE_SHA,
			trigger_evaluation: ledger,
			batch_id: batchId,
			max_concurrent: 1,
			lanes: [
				{
					id: `${batchId}-lane`,
					agent: 'explorer',
					prompt: 'Review the exact PR diff for this risk family.',
					workflow_lane: workflowLane,
				},
			],
		},
		tempDir,
		{ sessionID: SESSION_ID },
	);
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	createdSessions = 0;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 500,
		changedFiles: 20,
		hasSubmoduleChange: false,
	});
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => PR_REVIEW_BASE_SHA;
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `micro-cycle-child-${++createdSessions}` },
			error: undefined,
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	await teardownPrWorkflowGateFixtures();
});

describe('PR-review trigger-evaluation and micro-dispatch cycle', () => {
	test('starts a micro lane from the complete inline ledger before the trigger receipt exists', async () => {
		await establishBaseCoverage();
		const beforeDispatch = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(beforeDispatch?.prReviewTriggerEvalPath).toBeUndefined();
		const ledger = triggerEvaluation();
		const firstMicroLane = PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0];
		const result = await dispatchMicro(
			'micro-cycle-start',
			ledger,
			firstMicroLane,
		);

		expect(result).toMatchObject({ success: true, pending: 1 });
		expect(createdSessions).toBe(1);
		const afterDispatch = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(afterDispatch?.prReviewTriggerEvalPath).toBeUndefined();
		expect(afterDispatch?.prReviewTriggerLedger).toEqual(ledger);
	});

	test('freezes the inline ledger across later micro batches and the final writer', async () => {
		await establishBaseCoverage();
		const ledger = triggerEvaluation();
		await expect(
			dispatchMicro(
				'micro-freeze-first',
				ledger,
				PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0],
			),
		).resolves.toMatchObject({ success: true, pending: 1 });
		await expect(
			dispatchMicro(
				'micro-freeze-same',
				structuredClone(ledger),
				PR_REVIEW_REQUIRED_MICRO_LANE_IDS[1],
			),
		).resolves.toMatchObject({ success: true, pending: 1 });
		expect(createdSessions).toBe(2);

		const resultDrift = structuredClone(ledger);
		resultDrift[0] = {
			trigger_id: resultDrift[0].trigger_id,
			result: 'NOT_TRIGGERED',
			evidence: 'Changed diff no longer appears applicable',
		};
		const driftedDispatch = await dispatchMicro(
			'micro-freeze-result-drift',
			resultDrift,
			'unclassified-risk',
		);
		expect(driftedDispatch.success).toBe(false);
		expect(driftedDispatch.message).toContain('exactly identical');
		// #2126: the final-receipt clause was removed; only classifications must
		// match at the receipt, so the message must not mention the final receipt.
		expect(driftedDispatch.message).not.toContain('and the final receipt');

		const evidenceDrift = structuredClone(ledger);
		evidenceDrift[0].evidence = 'different evidence for the same result';
		const evidenceDispatch = await dispatchMicro(
			'micro-freeze-evidence-drift',
			evidenceDrift,
			'unclassified-risk',
		);
		expect(evidenceDispatch.success).toBe(false);
		expect(evidenceDispatch.message).toContain('exactly identical');
		expect(evidenceDispatch.message).not.toContain('and the final receipt');
		expect(createdSessions).toBe(2);

		const writerRows = resultDrift.map((row) =>
			row.result === 'MATCHED'
				? {
						...row,
						source_batch_id: 'micro-freeze-same',
						source_lane_id: 'micro-freeze-same-lane',
					}
				: row,
		);
		const writerResult = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'micro-freeze-writer-drift',
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: PR_REVIEW_BASE_SHA,
					rows: writerRows,
				},
				tempDir,
				{ sessionID: SESSION_ID },
			),
		);
		expect(writerResult.success).toBe(false);
		expect(writerResult.message).toContain('classification drift');
		expect(writerResult.message).toContain(resultDrift[0].trigger_id);
		const afterWriter = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(afterWriter?.prReviewTriggerEvalPath).toBeUndefined();
	});
});
