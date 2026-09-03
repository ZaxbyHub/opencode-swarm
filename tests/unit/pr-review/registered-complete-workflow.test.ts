import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
	type SessionOps,
} from '../../../src/tools/dispatch-lanes.js';
import { executeSubmitPrReviewResult } from '../../../src/tools/submit-pr-review-result.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	executeWritePrReviewTriggerEval,
	_internals as triggerInternals,
} from '../../../src/tools/write-pr-review-trigger-eval.js';
import {
	artifactRecord,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'registered-complete-workflow';
const originals = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	revisionDetailed: gateInternals.resolvePrWorkflowRevisionDigestDetailed,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
	sessions: dispatchInternals.getSessionOps,
	agents: dispatchInternals.getGeneratedAgentNames,
	dispatchRevision: dispatchInternals.resolvePrWorkflowRevisionDigestAsync,
	dispatchBase: dispatchInternals.resolveExactMergeBaseAsync,
	dispatchConfig: dispatchInternals.loadPluginConfig,
	triggerRevision: triggerInternals.resolvePrWorkflowRevisionDigest,
	triggerRevisionAsync: triggerInternals.resolvePrWorkflowRevisionDigestAsync,
	triggerBase: triggerInternals.resolveMergeBase,
	triggerBaseAsync: triggerInternals.resolveMergeBaseAsync,
};
let directory = '';
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
let resilienceEnabled = false;
function parsed(value: string): Record<string, unknown> & { success: boolean } {
	return JSON.parse(value) as Record<string, unknown> & { success: boolean };
}
function cleanEnvelope(workflowLanes: readonly string[]) {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: [...workflowLanes],
		findings: [],
		cleanAttestations: workflowLanes.map((workflowLane) => ({
			coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
			evidence: 'Registered child found no actionable defect.',
			workflowLane,
		})),
		unresolved: [],
	};
}
async function finishRecord(
	record: ReturnType<typeof findByBatchId>[number],
	text: string,
): Promise<void> {
	const stored = storeLaneOutput(directory, {
		batchId: record.batchId!,
		laneId: record.laneId!,
		agent: record.swarmPrefixedAgent,
		role: record.normalizedAgent,
		sessionId: record.subagentSessionId,
		parentSessionId: SESSION_ID,
		mode: record.mode,
		workflowLane: record.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: record.workspace?.scope ?? undefined,
		source: 'collect_lane_results',
		text,
	});
	const terminal = await claimTerminalResult(directory, record.correlationId, {
		eventId: `${RUN_ID}-${record.correlationId}`,
		status: 'completed',
		recordedAt: 1,
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			...(stored.ref ? { outputRef: stored.ref } : {}),
		},
	});
	expect(terminal?.disposition).toBe('claimed');
}

async function submitAndFinish(batchId: string): Promise<void> {
	for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
		if (!record.workflowLane || !record.laneId) throw new Error('missing lane');
		const prompt = deliveredPrompts.get(record.subagentSessionId);
		if (!prompt) throw new Error('missing rendered child prompt');
		const promptField = (name: string): string => {
			const value = prompt
				.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]
				?.trim();
			if (!value) throw new Error(`missing ${name} in rendered child prompt`);
			return value;
		};
		const promptBatchId = promptField('batch_id');
		const promptLaneId = promptField('lane_id');
		const promptWorkflowLane = promptField('workflow_lane');
		const promptRevisionDigest = promptField('revision_digest');
		const promptOwnedLanes = prompt
			.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
			?.split(',')
			.map((lane) => lane.trim()) ?? [promptWorkflowLane];
		const result = parsed(
			await executeSubmitPrReviewResult(
				{
					schemaVersion: 1,
					batchId: promptBatchId,
					laneId: promptLaneId,
					revisionDigest: promptRevisionDigest,
					result: cleanEnvelope(promptOwnedLanes),
				},
				directory,
				{ sessionID: record.subagentSessionId },
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		expect(promptBatchId).toBe(batchId);
		expect(promptLaneId).toBe(record.laneId);
		expect(
			findByCorrelationId(directory, record.subagentSessionId)?.result
				?.prReviewResultReceipt?.envelope.creditedLanes,
		).toEqual(record.ownedWorkflowLanes ?? [record.workflowLane]);
		const header =
			record.mode === 'swarm-pr-review:micro'
				? CANDIDATE_HEADERS.micro_lane
				: CANDIDATE_HEADERS.base_explorer;
		await finishRecord(
			record,
			`${header}\n[CLEAN] | ${record.workflowLane} | exact reviewed diff | no actionable finding survived`,
		);
	}
}

async function dispatch(
	batchId: string,
	mode: 'swarm-pr-review:base' | 'swarm-pr-review:micro',
	workflowLanes: readonly (string | readonly string[])[],
	triggerEvaluation?: PrReviewInlineTriggerRow[],
	wave?: { stage: 'canary' | 'fanout'; attempt: 0 | 1 | 2 },
): Promise<void> {
	const lanes = workflowLanes.map((entry) => {
		const owned = typeof entry === 'string' ? [entry] : [...entry];
		return {
			id: `${mode.endsWith(':base') ? 'base' : 'micro'}-${owned.join('-')}`,
			agent: 'explorer',
			prompt: `Review ${owned.join(', ')} on the exact bound diff.`,
			workflow_lane: owned[0]!,
			...(owned.length > 1 ? { owned_workflow_lanes: owned } : {}),
		};
	});
	const result = await executeDispatchLanesAsync(
		{
			batch_id: batchId,
			mode,
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: 'origin/main',
			max_concurrent: lanes.length,
			...(triggerEvaluation ? { trigger_evaluation: triggerEvaluation } : {}),
			...(wave
				? {
						pr_review_wave_stage: wave.stage,
						pr_review_wave_attempt: wave.attempt,
					}
				: {}),
			lanes,
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	expect(result).toMatchObject({
		success: true,
		pending: lanes.length,
	});
}

async function advanceWorkflowRevision(): Promise<number> {
	return withSessionStateMutation(directory, SESSION_ID, async () => {
		const current = await readPrWorkflowGateState(directory, SESSION_ID);
		if (!current?.workflowInstanceId)
			throw new Error('missing active workflow');
		const written = await writeStateWhileLocked(directory, {
			...current,
			updatedAt: '2026-01-01T00:00:00.000Z',
		});
		return written.revision;
	});
}

async function writeFindings(
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	status: 'PENDING' | 'DISPROVED',
	nextAction: 'route_to_reviewer' | 'suppress_with_reason',
): Promise<void> {
	const result = parsed(
		await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				boundary,
				records: [artifactRecord('CLEAN-REVIEW', status, nextAction, 'NONE')],
			},
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result.success).toBe(true);
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-registered-complete-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	resilienceEnabled = false;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed = () => ({
		ok: true,
		digest: REVISION_DIGEST,
	});
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => BASE_SHA;
	dispatchInternals.loadPluginConfig = () => ({
		pr_review_resilience: {
			...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			enabled: resilienceEnabled,
		},
	});
	dispatchInternals.getGeneratedAgentNames = () => ['explorer', 'reviewer'];
	const sessionOps: SessionOps = {
		create: mock(async () => ({
			data: { id: `registered-complete-child-${++nextChild}` },
			error: undefined,
		})),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async (args) => {
			deliveredPrompts.set(args.path.id, args.body.parts[0]?.text ?? '');
			return { data: undefined, error: undefined };
		}),
		delete: mock(async () => undefined),
	};
	dispatchInternals.getSessionOps = () => sessionOps;
	triggerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	triggerInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	triggerInternals.resolveMergeBase = () => BASE_SHA;
	triggerInternals.resolveMergeBaseAsync = async () => BASE_SHA;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.head;
	gateInternals.resolveCurrentGitHeadAsync = originals.headAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originals.revision;
	gateInternals.resolvePrWorkflowRevisionDigestDetailed =
		originals.revisionDetailed;
	gateInternals.resolveIsWorkingTreeClean = originals.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync = originals.cleanAsync;
	gateInternals.resolvePrReviewDiffStats = originals.diffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originals.diffStatsAsync;
	dispatchInternals.getSessionOps = originals.sessions;
	dispatchInternals.getGeneratedAgentNames = originals.agents;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originals.dispatchRevision;
	dispatchInternals.resolveExactMergeBaseAsync = originals.dispatchBase;
	dispatchInternals.loadPluginConfig = originals.dispatchConfig;
	triggerInternals.resolvePrWorkflowRevisionDigest = originals.triggerRevision;
	triggerInternals.resolvePrWorkflowRevisionDigestAsync =
		originals.triggerRevisionAsync;
	triggerInternals.resolveMergeBase = originals.triggerBase;
	triggerInternals.resolveMergeBaseAsync = originals.triggerBaseAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('registered tier-M PR_REVIEW completion (#2469)', () => {
	test.each([
		false,
		true,
	])('consolidated receipts reach COMPLETE with resilience enabled=%s', async (enabled) => {
		resilienceEnabled = enabled;
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		const baseBatchIds = enabled
			? ['registered-complete-canary', 'registered-complete-fanout']
			: ['registered-complete-base'];
		if (enabled) {
			await dispatch(
				baseBatchIds[0]!,
				'swarm-pr-review:base',
				[PR_REVIEW_BASE_DIMENSION_IDS[0]!],
				undefined,
				{ stage: 'canary', attempt: 0 },
			);
			await submitAndFinish(baseBatchIds[0]!);
			await dispatch(
				baseBatchIds[1]!,
				'swarm-pr-review:base',
				[
					PR_REVIEW_BASE_DIMENSION_IDS.slice(1, 3),
					PR_REVIEW_BASE_DIMENSION_IDS.slice(3),
				],
				undefined,
				{ stage: 'fanout', attempt: 0 },
			);
		} else {
			await dispatch(baseBatchIds[0]!, 'swarm-pr-review:base', [
				PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
				PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
				PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
			]);
		}
		const dispatchRevision = findByBatchId(
			directory,
			baseBatchIds.at(-1)!,
			SESSION_ID,
		)[0]!.workflowGeneration!;
		const advancedRevision = await advanceWorkflowRevision();
		expect(advancedRevision).toBeGreaterThan(dispatchRevision);
		for (const batchId of enabled ? baseBatchIds.slice(1) : baseBatchIds) {
			await submitAndFinish(batchId);
		}
		for (const batchId of baseBatchIds) {
			for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
				expect(record.result?.prReviewResultReceipt?.workflowRevision).toBe(
					record.workflowGeneration,
				);
				expect(record.prReviewLegacyTranscriptCompatibility).toBe(false);
			}
		}

		const inlineTriggers: PrReviewInlineTriggerRow[] =
			PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map((triggerId) => ({
				trigger_id: triggerId,
				result: 'MATCHED',
				evidence: `The bound diff requires focused review for ${triggerId}.`,
			}));
		const triggerRows: Array<Record<string, string>> = [];
		for (
			let offset = 0;
			offset < PR_REVIEW_REQUIRED_MICRO_LANE_IDS.length;
			offset += 6
		) {
			const lanes = PR_REVIEW_REQUIRED_MICRO_LANE_IDS.slice(offset, offset + 6);
			const batchId = `registered-complete-micro-${offset / 6}`;
			await dispatch(
				batchId,
				'swarm-pr-review:micro',
				lanes,
				offset === 0 ? inlineTriggers : undefined,
			);
			await submitAndFinish(batchId);
			for (const record of findByBatchId(directory, batchId, SESSION_ID)) {
				triggerRows.push({
					trigger_id: record.workflowLane!,
					result: 'MATCHED',
					evidence: `Registered micro receipt covers ${record.workflowLane}.`,
					source_batch_id: batchId,
					source_lane_id: record.laneId!,
				});
			}
		}
		const trigger = parsed(
			await executeWritePrReviewTriggerEval(
				{
					run_id: RUN_ID,
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: BASE_SHA,
					rows: triggerRows,
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(trigger.success).toBe(true);

		await writeFindings('post_explorer', 'PENDING', 'route_to_reviewer');
		const reviewerBatchId = `${RUN_ID}-reviewer`;
		const reviewer = await executeDispatchLanesAsync(
			{
				batch_id: reviewerBatchId,
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				max_concurrent: 1,
				lanes: [
					{
						id: `${RUN_ID}-reviewer-lane`,
						agent: 'reviewer',
						prompt: 'Classify the clean-review sentinel.',
						workflow_lane: `${RUN_ID}-reviewer-lane`,
						review_item_ids: ['CLEAN-REVIEW'],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(reviewer.success).toBe(true);
		await finishRecord(
			findByBatchId(directory, reviewerBatchId, SESSION_ID)[0]!,
			reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE'),
		);
		await writeFindings('post_reviewer', 'DISPROVED', 'suppress_with_reason');
		await writeFindings('post_critic', 'DISPROVED', 'suppress_with_reason');

		const completion = parsed(
			await executeCompletePrWorkflow(
				{
					mode: 'PR_REVIEW',
					pr_head_sha: HEAD_SHA,
					report_verdict: 'APPROVE',
				},
				directory,
				{ sessionID: SESSION_ID },
			),
		) as ReturnType<typeof parsed> & {
			status: string;
			terminal_report: {
				kind: string;
				covered_dimensions: string[];
				unresolved_dimensions: unknown[];
				live_dimensions: string[];
				allowed_verdicts: string[];
			};
		};
		expect(completion).toMatchObject({
			success: true,
			status: 'completed',
			gate_cleared: true,
			terminal_report: {
				kind: 'COMPLETE',
				unresolved_dimensions: [],
				live_dimensions: [],
			},
		});
		expect(new Set(completion.terminal_report.covered_dimensions)).toEqual(
			new Set(PR_REVIEW_BASE_DIMENSION_IDS),
		);
		expect(completion.terminal_report.allowed_verdicts).toContain('APPROVE');
	});
});
