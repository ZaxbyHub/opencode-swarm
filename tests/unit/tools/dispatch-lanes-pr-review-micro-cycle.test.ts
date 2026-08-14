import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByBatchId,
} from '../../../src/background/pending-delegations.js';
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
import {
	executeWritePrReviewTriggerEval,
	_internals as writerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
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
const originalWriterResolveRevision =
	writerInternals.resolvePrWorkflowRevisionDigest;
const originalWriterResolveMergeBase = writerInternals.resolveMergeBase;
let createdSessions = 0;
let sentPrompts: string[] = [];

function triggerEvaluation(): PrReviewInlineTriggerRow[] {
	return PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
		trigger_id: triggerId,
		result: 'MATCHED' as const,
		evidence: `Changed behavior requires focused review for ${triggerId}`,
	}));
}

function focusedRetryEvaluation(): PrReviewInlineTriggerRow[] {
	return PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
		trigger_id: triggerId,
		result:
			triggerId === 'auth-identity-secrets' || triggerId === 'unclassified-risk'
				? ('MATCHED' as const)
				: ('NOT_TRIGGERED' as const),
		evidence: `Exact diff evaluation for ${triggerId} has concrete evidence`,
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
	ledger: unknown,
	workflowLane: string,
) {
	return executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:micro',
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: PR_REVIEW_BASE_SHA,
			scope: PR_REVIEW_SCOPE,
			...(ledger === undefined ? {} : { trigger_evaluation: ledger }),
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

async function settleDispatchedBatch(
	batchId: string,
	status: 'completed' | 'error',
): Promise<void> {
	const records = findByBatchId(tempDir, batchId, SESSION_ID);
	expect(records.length).toBeGreaterThan(0);
	for (const record of records) {
		const workflowLane = record.workflowLane!;
		const text =
			status === 'completed'
				? `${CANDIDATE_HEADERS.micro_lane}\n[CLEAN] | ${workflowLane} | complete focused invariant review | no issue found after tracing the exact changed behavior`
				: `${CANDIDATE_HEADERS.micro_lane}\n[CANDIDATE] | malformed | ${workflowLane} | LOW | correctness | src/a.ts:1 | claim | invariant | evidence | base-only impact | MEDIUM`;
		const stored = storeLaneOutput(tempDir, {
			batchId,
			laneId: record.laneId!,
			agent: record.swarmPrefixedAgent,
			role: record.normalizedAgent,
			sessionId: record.subagentSessionId,
			parentSessionId: SESSION_ID,
			mode: record.mode,
			workflowLane,
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			scope: PR_REVIEW_SCOPE,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(tempDir, record.correlationId, {
			status,
			result: {
				...(status === 'completed'
					? { text }
					: { error: 'PR_REVIEW_DISCOVERY_CONTRACT_INVALID' }),
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				...(stored.ref ? { outputRef: stored.ref } : {}),
			},
		});
	}
}

beforeEach(() => {
	setupPrWorkflowGateFixtures();
	createdSessions = 0;
	sentPrompts = [];
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 500,
		changedFiles: 20,
		hasSubmoduleChange: false,
	});
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => PR_REVIEW_BASE_SHA;
	writerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	writerInternals.resolveMergeBase = () => PR_REVIEW_BASE_SHA;
	dispatchInternals.getGeneratedAgentNames = () => ['explorer'];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `micro-cycle-child-${++createdSessions}` },
			error: undefined,
		})),
		promptAsync: mock(async (input) => {
			sentPrompts.push(input.body.parts[0].text);
			return { data: undefined, error: undefined };
		}),
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
	writerInternals.resolvePrWorkflowRevisionDigest =
		originalWriterResolveRevision;
	writerInternals.resolveMergeBase = originalWriterResolveMergeBase;
	await teardownPrWorkflowGateFixtures();
});

describe('PR-review trigger-evaluation and micro-dispatch cycle', () => {
	test('requires the complete ledger before any same-session micro dispatch has frozen it', async () => {
		await establishBaseCoverage();
		const result = await dispatchMicro(
			'micro-cycle-initial-omission',
			undefined,
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0],
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'initial PR_REVIEW micro dispatch requires',
		);
		expect(createdSessions).toBe(0);
	});

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
		expect(sentPrompts).toHaveLength(1);
		expect(sentPrompts[0]).toContain(CANDIDATE_HEADERS.micro_lane);
		expect(sentPrompts[0]).not.toContain(CANDIDATE_HEADERS.base_explorer);
		expect(sentPrompts[0]).not.toContain('impact_context');
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
				undefined,
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

	test('falls back only for true same-session omission and rejects invalid or corrupt state', async () => {
		await establishBaseCoverage();
		const ledger = triggerEvaluation();
		await expect(
			dispatchMicro(
				'micro-fallback-freeze',
				ledger,
				PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0],
			),
		).resolves.toMatchObject({ success: true });

		for (const [index, invalid] of [
			null,
			[],
			[{ trigger_id: 'invalid' }],
		].entries()) {
			const result = await dispatchMicro(
				`micro-explicit-invalid-${index}`,
				invalid,
				PR_REVIEW_REQUIRED_MICRO_LANE_IDS[1],
			);
			expect(result.success).toBe(false);
		}
		const otherSession = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: PR_REVIEW_BASE_SHA,
				batch_id: 'micro-cross-session',
				max_concurrent: 1,
				lanes: [
					{
						id: 'cross-session-lane',
						agent: 'explorer',
						prompt: 'must not borrow another session ledger',
						workflow_lane: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[1],
					},
				],
			},
			tempDir,
			{ sessionID: `${SESSION_ID}-other` },
		);
		expect(otherSession.success).toBe(false);

		const gateDir = join(tempDir, '.swarm', 'pr-workflow-gates');
		const gatePath = join(gateDir, readdirSync(gateDir)[0]);
		const rawState = JSON.parse(readFileSync(gatePath, 'utf8'));
		rawState.prReviewTriggerLedger = rawState.prReviewTriggerLedger.slice(1);
		writeFileSync(gatePath, `${JSON.stringify(rawState)}\n`, 'utf8');
		gateInternals.resetTrackedStateCache();
		const corrupt = await dispatchMicro(
			'micro-corrupt-frozen',
			undefined,
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS[1],
		);
		expect(corrupt.success).toBe(false);
		expect(corrupt.message).toMatch(/gate state|trigger|ledger|row/i);
		expect(createdSessions).toBe(1);
	});

	test('uses an omitted-ledger retry artifact for final trigger provenance while rejecting the failed original', async () => {
		await establishBaseCoverage();
		const ledger = focusedRetryEvaluation();
		await expect(
			dispatchMicro('micro-retry-original', ledger, 'auth-identity-secrets'),
		).resolves.toMatchObject({ success: true, pending: 1 });
		await settleDispatchedBatch('micro-retry-original', 'error');

		const retryBatch = 'micro-retry-success';
		const retry = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: HEAD_SHA,
				base_ref: 'origin/main',
				base_sha: PR_REVIEW_BASE_SHA,
				scope: PR_REVIEW_SCOPE,
				batch_id: retryBatch,
				max_concurrent: 2,
				lanes: ['auth-identity-secrets', 'unclassified-risk'].map(
					(workflowLane) => ({
						id: `retry-${workflowLane}`,
						agent: 'explorer',
						prompt: 'Retry the exact failed or outstanding risk family.',
						workflow_lane: workflowLane,
					}),
				),
			},
			tempDir,
			{ sessionID: SESSION_ID },
		);
		expect(retry).toMatchObject({ success: true, pending: 2 });
		await settleDispatchedBatch(retryBatch, 'completed');

		const rowsFrom = (authBatch: string, authLane: string) =>
			ledger.map((row) =>
				row.result === 'MATCHED'
					? {
							...row,
							source_batch_id:
								row.trigger_id === 'auth-identity-secrets'
									? authBatch
									: retryBatch,
							source_lane_id:
								row.trigger_id === 'auth-identity-secrets'
									? authLane
									: 'retry-unclassified-risk',
						}
					: row,
			);

		const rejected = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'micro-retry-failed-original',
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: PR_REVIEW_BASE_SHA,
					rows: rowsFrom('micro-retry-original', 'micro-retry-original-lane'),
				},
				tempDir,
				{ sessionID: SESSION_ID },
			),
		);
		expect(rejected.success).toBe(false);
		expect(rejected.message).toMatch(/completed|provenance|artifact/i);

		const accepted = JSON.parse(
			await executeWritePrReviewTriggerEval(
				{
					run_id: 'micro-retry-complete',
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: PR_REVIEW_BASE_SHA,
					rows: rowsFrom(retryBatch, 'retry-auth-identity-secrets'),
				},
				tempDir,
				{ sessionID: SESSION_ID },
			),
		);
		expect(accepted.success).toBe(true);
		const finalState = await readPrWorkflowGateState(tempDir, SESSION_ID);
		expect(finalState?.prReviewTriggerEvalPath).toBe(accepted.path);
	});
});
