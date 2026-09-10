import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { executePreparePrWorkflowCheckout } from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	artifactRecord,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
	reviewedRow,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 check C14 (AC9/R17): finalization happens once for the current run.
 * Gate clear is single-shot, leaves zero live lanes, is refused for foreign
 * sessions, and competes with neither reactivation nor checkout restoration.
 */
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const OTHER_SESSION_ID = 'r17-other-session';
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r17-finalization';
let directory = '';
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
let restoreGateSeams: () => void = () => undefined;
let restoreDispatchSeams: () => void = () => undefined;
let restoreTriggerSeams: () => void = () => undefined;
function pinSeams(
	host: Record<string, unknown>,
	stubs: Record<string, unknown>,
): () => void {
	const saved = new Map(
		Object.keys(stubs).map((key) => [key, host[key]] as const),
	);
	for (const [key, value] of Object.entries(stubs)) host[key] = value;
	return () => {
		for (const [key, value] of saved) host[key] = value;
	};
}
async function removeTempDir(): Promise<void> {
	closeAllProjectDbs();
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}
const parsed = (
	value: string,
): Record<string, unknown> & { success: boolean } =>
	JSON.parse(value) as Record<string, unknown> & { success: boolean };
function stats() {
	return { changedLines: 400, changedFiles: 12, hasSubmoduleChange: false };
}
function cleanEnvelope(workflowLanes: readonly string[]) {
	return {
		schemaVersion: 1,
		outcome: 'CLEAN',
		creditedLanes: [...workflowLanes],
		findings: [],
		cleanAttestations: workflowLanes.map((workflowLane) => ({
			coverageScope: `Complete ${workflowLane} surface on the bound diff.`,
			evidence: 'Registered child found no actionable defect for finalization.',
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
		const promptField = (name: string) =>
			prompt.match(new RegExp(`^${name}: (.+)$`, 'm'))?.[1]?.trim() ?? '';
		const promptOwnedLanes = prompt
			.match(/^owned_workflow_lanes: (.+?) —/m)?.[1]
			?.split(',')
			.map((lane) => lane.trim()) ?? [promptField('workflow_lane')];
		const result = parsed(
			String(
				await plugin.tool.submit_pr_review_result.execute(
					{
						schemaVersion: 1,
						batchId: promptField('batch_id'),
						laneId: promptField('lane_id'),
						revisionDigest: promptField('revision_digest'),
						result: cleanEnvelope(promptOwnedLanes),
					},
					{ directory, sessionID: record.subagentSessionId },
				),
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
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
	const result = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: batchId,
					mode,
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					max_concurrent: lanes.length,
					...(triggerEvaluation
						? { trigger_evaluation: triggerEvaluation }
						: {}),
					lanes,
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result).toMatchObject({ success: true, pending: lanes.length });
}
async function writeFindings(
	boundary: 'post_explorer' | 'post_reviewer' | 'post_critic',
	status: 'PENDING' | 'DISPROVED',
	nextAction: 'route_to_reviewer' | 'suppress_with_reason',
): Promise<void> {
	const result = parsed(
		String(
			await plugin.tool.write_pr_review_artifact.execute(
				{
					kind: 'findings',
					run_id: RUN_ID,
					pr_head_sha: HEAD_SHA,
					boundary,
					records: [artifactRecord('CLEAN-REVIEW', status, nextAction, 'NONE')],
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result.success).toBe(true);
}
/** Base coverage + micro sweep + trigger eval + findings ladder, then COMPLETE. */
async function runCleanWorkflowToCompletion(): Promise<void> {
	await dispatch('r17-base', 'swarm-pr-review:base', [
		PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
		PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
		PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
	]);
	await submitAndFinish('r17-base');
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
		const batchId = `r17-micro-${offset / 6}`;
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
		String(
			await plugin.tool.write_pr_review_trigger_eval.execute(
				{
					run_id: RUN_ID,
					pr_head_sha: HEAD_SHA,
					base_ref: 'origin/main',
					base_sha: BASE_SHA,
					rows: triggerRows,
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(trigger.success).toBe(true);
	await writeFindings('post_explorer', 'PENDING', 'route_to_reviewer');
	const reviewer = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: `${RUN_ID}-reviewer`,
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
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(reviewer.success).toBe(true);
	await finishRecord(
		findByBatchId(directory, `${RUN_ID}-reviewer`, SESSION_ID)[0]!,
		reviewedRow('CLEAN-REVIEW', 'DISPROVED', 'NONE'),
	);
	await writeFindings('post_reviewer', 'DISPROVED', 'suppress_with_reason');
	await writeFindings('post_critic', 'DISPROVED', 'suppress_with_reason');
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r17-finalization-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	gateInternals.resetTrackedStateCache();
	restoreGateSeams = pinSeams(
		gateInternals as unknown as Record<string, unknown>,
		{
			resolveCurrentGitHead: () => HEAD_SHA,
			resolveCurrentGitHeadAsync: async () => HEAD_SHA,
			resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
			resolvePrWorkflowRevisionDigestDetailed: () => ({
				ok: true,
				digest: REVISION_DIGEST,
			}),
			resolveIsWorkingTreeClean: () => true,
			resolveIsWorkingTreeCleanAsync: async () => true,
			resolvePrReviewDiffStats: () => stats(),
			resolvePrReviewDiffStatsAsync: async () => stats(),
		},
	);
	restoreDispatchSeams = pinSeams(
		dispatchInternals as unknown as Record<string, unknown>,
		{
			resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
			resolveExactMergeBaseAsync: async () => BASE_SHA,
			loadPluginConfig: () => ({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}),
			getGeneratedAgentNames: () => ['explorer', 'reviewer'],
		},
	);
	restoreTriggerSeams = pinSeams(
		triggerInternals as unknown as Record<string, unknown>,
		{
			resolvePrWorkflowRevisionDigest: () => REVISION_DIGEST,
			resolvePrWorkflowRevisionDigestAsync: async () => REVISION_DIGEST,
			resolveMergeBase: () => BASE_SHA,
			resolveMergeBaseAsync: async () => BASE_SHA,
		},
	);
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r17-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
});
afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	restoreGateSeams();
	restoreDispatchSeams();
	restoreTriggerSeams();
	await removeTempDir();
});
describe('R17 finalization concurrency (#2585 C14/AC9)', () => {
	test('another session cannot complete, reactivate, or restore while the workflow is active', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await dispatch('r17-live-base', 'swarm-pr-review:base', [
			PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(2, 4),
			PR_REVIEW_BASE_DIMENSION_IDS.slice(4),
		]);
		const foreignCompletion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: HEAD_SHA,
						report_verdict: 'APPROVE',
					},
					{ directory, sessionID: OTHER_SESSION_ID },
				),
			),
		);
		expect(foreignCompletion.success).toBe(false);
		expect(String(foreignCompletion.message)).toContain(
			`BLOCKED: no active PR workflow gate for session "${OTHER_SESSION_ID}"`,
		);
		await expect(
			activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK'),
		).rejects.toThrow(
			`BLOCKED: session "${SESSION_ID}" already has an active PR_REVIEW workflow; complete it before starting PR_FEEDBACK`,
		);
		const restoreWhileActive = parsed(
			String(
				await executePreparePrWorkflowCheckout(
					{ operation: 'restore' },
					directory,
					{ sessionID: SESSION_ID },
				),
			),
		);
		expect(restoreWhileActive).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_GATE_ACTIVE',
			retryable: false,
		});
		expect(String(restoreWhileActive.message)).toContain(
			'checkout restoration is allowed only after complete_pr_workflow or abort_pr_workflow clears the active gate',
		);
		const foreignRestore = parsed(
			String(
				await executePreparePrWorkflowCheckout(
					{ operation: 'restore' },
					directory,
					{ sessionID: OTHER_SESSION_ID },
				),
			),
		);
		expect(foreignRestore).toMatchObject({
			success: false,
			code: 'CHECKOUT_RESTORE_OTHER_SESSION_ACTIVE',
			retryable: false,
		});
		expect(String(foreignRestore.message)).toContain(
			`checkout restoration cannot mutate this project while session "${SESSION_ID}" has an active PR_REVIEW workflow`,
		);
	}, 30_000);
	test('gate clear happens once and leaves zero live lanes', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await runCleanWorkflowToCompletion();
		const completion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: HEAD_SHA,
						report_verdict: 'APPROVE',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(completion).toMatchObject({
			success: true,
			status: 'completed',
			gate_cleared: true,
		});
		const secondCompletion = parsed(
			String(
				await plugin.tool.complete_pr_workflow.execute(
					{
						mode: 'PR_REVIEW',
						pr_head_sha: HEAD_SHA,
						report_verdict: 'APPROVE',
					},
					{ directory, sessionID: SESSION_ID },
				),
			),
		);
		expect(secondCompletion.success).toBe(false);
		expect(String(secondCompletion.message)).toContain(
			`BLOCKED: no active PR workflow gate for session "${SESSION_ID}"`,
		);
		// The recovery-scan surface (prepare-pr-workflow-checkout.ts
		// countOpenPrWorkflowLanes filter) finds zero live PR lanes.
		const scan = scanDelegationsForRecovery(directory);
		expect(scan.status).toBe('ok');
		if (scan.status !== 'ok') return;
		const openLanes = scan.owners.filter(
			(record) =>
				record.parentSessionId === SESSION_ID &&
				typeof record.mode === 'string' &&
				record.mode.startsWith('swarm-pr-') &&
				(record.status === 'pending' || record.status === 'running'),
		);
		expect(openLanes).toEqual([]);
	}, 60_000);
});
