import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CANDIDATE_HEADERS } from '../../../src/background/candidate-contract.js';
import {
	readLaneOutput,
	storeLaneOutput,
} from '../../../src/background/lane-output-store.js';
import {
	claimTerminalResult,
	findByBatchId,
	findByCorrelationId,
} from '../../../src/background/pending-delegations.js';
import type { PrReviewInlineTriggerRow } from '../../../src/background/pr-review-trigger-contract.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { reducePrReviewEvent } from '../../../src/pr-review/reducer.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as triggerInternals } from '../../../src/tools/write-pr-review-trigger-eval.js';
import { createIssue2469HostClient } from '../../helpers/issue-2469-registered-host.js';
import { bootKnowledgeHost } from '../../helpers/knowledge-real-host.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

/**
 * #2585 check C11 (AC6/R13): interrupt/restart/compaction preserves completed
 * receipts and workflowGeneration. Process-restart is simulated by dropping the
 * gate's in-memory tracked-state cache and re-reading every durable surface
 * from disk; replay idempotency and the stale-generation rejection are the
 * reducer-owned transition rules at src/pr-review/reducer.ts:193-219.
 */
const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const BASE_SHA = 'b'.repeat(40);
const REVISION_DIGEST = 'e'.repeat(64);
const RUN_ID = 'r13-resume-compaction';
const CHILD_BATCH = 'r13-base';
const originals = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	revisionDetailed: gateInternals.resolvePrWorkflowRevisionDigestDetailed,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	diffStats: gateInternals.resolvePrReviewDiffStats,
	diffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
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
let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
let nextChild = 0;
let deliveredPrompts = new Map<string, string>();
const replayableSubmissions: Array<{
	childSessionId: string;
	args: Record<string, unknown>;
}> = [];

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
			evidence: 'Registered child found no actionable defect after restart.',
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
		const args = {
			schemaVersion: 1,
			batchId: promptBatchId,
			laneId: promptLaneId,
			revisionDigest: promptRevisionDigest,
			result: cleanEnvelope(promptOwnedLanes),
		};
		const result = parsed(
			String(
				await plugin.tool.submit_pr_review_result.execute(args, {
					directory,
					sessionID: record.subagentSessionId,
				}),
			),
		);
		expect(result).toMatchObject({ success: true, status: 'recorded' });
		replayableSubmissions.push({
			childSessionId: record.subagentSessionId,
			args,
		});
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
async function dispatchBase(batchId: string): Promise<void> {
	const lanes = [0, 2, 4].map((offset) => {
		const owned = PR_REVIEW_BASE_DIMENSION_IDS.slice(offset, offset + 2);
		return {
			id: `base-${owned.join('-')}`,
			agent: 'explorer',
			prompt: `Review ${owned.join(', ')} on the exact bound diff.`,
			workflow_lane: owned[0]!,
			owned_workflow_lanes: owned,
		};
	});
	const result = parsed(
		String(
			await plugin.tool.dispatch_lanes_async.execute(
				{
					batch_id: batchId,
					mode: 'swarm-pr-review:base',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					max_concurrent: lanes.length,
					lanes,
				},
				{ directory, sessionID: SESSION_ID },
			),
		),
	);
	expect(result).toMatchObject({ success: true, pending: lanes.length });
}
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-r13-resume-');
	await initializeGitRepository(directory);
	nextChild = 0;
	deliveredPrompts = new Map();
	replayableSubmissions.length = 0;
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
			enabled: false,
		},
	});
	dispatchInternals.getGeneratedAgentNames = () => ['explorer', 'reviewer'];
	triggerInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	triggerInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	triggerInternals.resolveMergeBase = () => BASE_SHA;
	triggerInternals.resolveMergeBaseAsync = async () => BASE_SHA;
	plugin = await bootKnowledgeHost(
		directory,
		{},
		createIssue2469HostClient({
			nextChildId: () => `r13-child-${++nextChild}`,
			onPrompt: (sessionID, prompt) => deliveredPrompts.set(sessionID, prompt),
		}),
	);
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
	await removeTempDir();
});
/** Windows teardown: release held handles, then bounded EBUSY-tolerant rm. */
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
describe('R13 resume/compaction after process restart (#2585 C11/AC6)', () => {
	test('durable receipts and workflowGeneration survive; replay is idempotent; late results and truncated transcripts cannot corrupt them', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
			prHeadSha: HEAD_SHA,
		});
		await dispatchBase(CHILD_BATCH);
		await submitAndFinish(CHILD_BATCH);
		const beforeRestart = await readPrWorkflowGateState(directory, SESSION_ID);
		if (!beforeRestart?.workflowInstanceId) throw new Error('missing workflow');
		const beforeRecords = findByBatchId(directory, CHILD_BATCH, SESSION_ID);
		expect(beforeRecords).toHaveLength(3);
		for (const record of beforeRecords) {
			expect(record.status).toBe('completed');
			expect(record.result?.prReviewResultReceipt).toBeDefined();
		}

		// --- Process-restart simulation: drop in-memory tracked state. ---
		gateInternals.resetTrackedStateCache();
		const afterRestart = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(afterRestart?.workflowInstanceId).toBe(
			beforeRestart.workflowInstanceId,
		);
		expect(afterRestart?.revision).toBe(beforeRestart.revision);
		const restartedRecords = findByBatchId(directory, CHILD_BATCH, SESSION_ID);
		expect(restartedRecords).toHaveLength(beforeRecords.length);
		for (const record of restartedRecords) {
			expect(record.status).toBe('completed');
			const receipt = record.result?.prReviewResultReceipt;
			expect(receipt?.workflowRevision).toBe(record.workflowGeneration);
			expect(receipt?.workflowInstanceId).toBe(
				afterRestart?.workflowInstanceId,
			);
		}

		// --- Byte-identical replay submission is idempotent (recorded ->
		//     duplicate, no second effect): reducer.ts:200-219. ---
		const replay = replayableSubmissions[0]!;
		const replayOutcome = parsed(
			String(
				await plugin.tool.submit_pr_review_result.execute(replay.args, {
					directory,
					sessionID: replay.childSessionId,
				}),
			),
		);
		expect(replayOutcome).toMatchObject({ success: true, status: 'duplicate' });
		const postReplayRecords = findByBatchId(directory, CHILD_BATCH, SESSION_ID);
		expect(postReplayRecords).toHaveLength(beforeRecords.length);
		const replayedRecord = findByCorrelationId(
			directory,
			replay.childSessionId,
		);
		const originalRecord = beforeRecords.find(
			(record) => record.correlationId === replay.childSessionId,
		);
		expect(replayedRecord?.status).toBe('completed');
		expect(
			replayedRecord?.result?.prReviewResultReceipt?.semanticEnvelopeDigest,
		).toBe(
			originalRecord?.result?.prReviewResultReceipt?.semanticEnvelopeDigest,
		);

		// --- A late old-generation submission is rejected with the exact
		//     stale-generation rejection (reducer.ts:193-199). ---
		const activeGeneration = afterRestart!.revision;
		const lateGeneration = activeGeneration - 1;
		const lateSubmission = reducePrReviewEvent(afterRestart!, {
			type: 'lane_structured_result_submitted',
			batchId: replayedRecord!.batchId!,
			laneId: replayedRecord!.laneId!,
			generation: lateGeneration,
			semanticEnvelopeDigest: 'f'.repeat(64),
			outcome: 'FINDINGS',
		});
		expect(lateSubmission.status).toBe('rejected');
		if (lateSubmission.status !== 'rejected') return;
		expect(lateSubmission.rejection.code).toBe('stale_generation_result');
		expect(lateSubmission.rejection.detail).toBe(
			`result generation ${lateGeneration} does not match the active generation ${activeGeneration}`,
		);
		expect(lateSubmission.state).toBe(afterRestart);

		// --- Simulated transcript truncation leaves durable receipts intact. ---
		const outputRef = replayedRecord?.result?.outputRef;
		if (typeof outputRef !== 'string') throw new Error('missing outputRef');
		const artifact = readLaneOutput(directory, outputRef);
		if (!artifact) throw new Error('missing lane output artifact');
		const [, batchDigest, laneDigest, outputDigest] = outputRef.split(':');
		const artifactPath = path.join(
			directory,
			'.swarm',
			'lane-results',
			batchDigest!,
			laneDigest!,
			`${outputDigest}.json`,
		);
		const truncated = {
			...artifact.artifact,
			text: artifact.artifact.text.slice(0, 12),
		};
		await fs.writeFile(artifactPath, JSON.stringify(truncated), 'utf8');
		expect(readLaneOutput(directory, outputRef)).toBeNull();
		const postTruncationState = await readPrWorkflowGateState(
			directory,
			SESSION_ID,
		);
		expect(postTruncationState?.revision).toBe(activeGeneration);
		const postTruncationRecords = findByBatchId(
			directory,
			CHILD_BATCH,
			SESSION_ID,
		);
		expect(postTruncationRecords).toHaveLength(beforeRecords.length);
		for (const record of postTruncationRecords) {
			expect(record.status).toBe('completed');
			expect(record.result?.prReviewResultReceipt?.workflowRevision).toBe(
				record.workflowGeneration,
			);
		}
	});
});
