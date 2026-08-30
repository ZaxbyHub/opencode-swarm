import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByBatchId,
} from '../../../src/background/pending-delegations.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const REVISION_DIGEST = 'revision-1';
const BASE_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const SESSION_ID = 'review-session-live-canary';

let directory = '';
const originalDispatchGetSessionOps = dispatchInternals.getSessionOps;
const originalDispatchLoadPluginConfig = dispatchInternals.loadPluginConfig;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;
const originalGateGetSessionOps = gateInternals.getSessionOps;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync =
	gateInternals.resolvePrReviewDiffStatsAsync;
const originalNowMs = gateInternals.nowMs;

function lane(id: string, workflowLane: string) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: workflowLane,
	};
}

function terminalErrorResult(error: string) {
	return {
		error,
		text: `[ERROR] ${error}`,
		chars: error.length + 8,
		truncated: false,
		digest: `digest-${error.length}`,
	};
}

async function appendSuccessfulBaseTransition(
	record: NonNullable<ReturnType<typeof findByBatchId>[number]>,
) {
	const text = [
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags',
		`${record.laneId}-candidate | ${record.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `,
	].join('\n');
	const stored = storeLaneOutput(directory, {
		batchId: record.batchId,
		laneId: record.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: record.subagentSessionId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-review:base',
		workflowLane: record.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: BASE_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, record.correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
		expectedCurrentStatuses: ['pending', 'running'],
	});
}

async function dispatchAttempt0LiveCanary() {
	const canary = await executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:base',
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: 'origin/main',
			pr_review_wave_stage: 'canary',
			pr_review_wave_attempt: 0,
			max_concurrent: 1,
			lanes: [lane('live-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	const record = findByBatchId(directory, String(canary.batch_id), {
		parentSessionId: SESSION_ID,
	})[0];
	const state = await readPrWorkflowGateState(directory, SESSION_ID);
	return { record, state };
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-late-canary-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 2_000,
		changedFiles: 60,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	gateInternals.getSessionOps = () => null;
	gateInternals.nowMs = originalNowMs;
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => BASE_SHA;
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
	dispatchInternals.loadPluginConfig = () =>
		({
			pr_review_resilience: {
				...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
				enabled: true,
			},
		}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	dispatchInternals.getSessionOps = originalDispatchGetSessionOps;
	dispatchInternals.loadPluginConfig = originalDispatchLoadPluginConfig;
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	gateInternals.getSessionOps = originalGateGetSessionOps;
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
	gateInternals.nowMs = originalNowMs;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('dispatch_lanes PR review resilience late canary', () => {
	test('late older failures still wait for a later attempts frozen fanout when that fanout remains nonempty', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const liveSessionIds = new Set<string>();
		gateInternals.getSessionOps = () =>
			({
				status: mock(async () => ({
					data: Object.fromEntries(
						[...liveSessionIds].map((sessionId) => [
							sessionId,
							{ type: 'busy' },
						]),
					),
				})),
			}) as ReturnType<typeof originalGateGetSessionOps>;

		const { record: attempt0CanaryRecord, state: attempt0State } =
			await dispatchAttempt0LiveCanary();
		gateInternals.nowMs = () =>
			Date.parse(
				attempt0State?.prReviewResilience?.attempts[0]?.admittedAt ?? '',
			) + 300_001;
		liveSessionIds.add(String(attempt0CanaryRecord?.subagentSessionId));

		const attempt0Fanout = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'fanout',
				pr_review_wave_attempt: 0,
				max_concurrent: 5,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.slice(1).map(
					(workflowLane, index) => lane(`fanout-${index}`, workflowLane!),
				),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt0Fanout.success).toBe(true);
		for (const record of findByBatchId(
			directory,
			String(attempt0Fanout.batch_id),
			{
				parentSessionId: SESSION_ID,
			},
		)) {
			if (
				record.laneId === 'fanout-0' ||
				record.laneId === 'fanout-3' ||
				record.laneId === 'fanout-4'
			) {
				await appendSuccessfulBaseTransition(record);
				continue;
			}
			await appendDelegationTransition(directory, record.correlationId, {
				status: 'error',
				result: terminalErrorResult(`fanout ${record.laneId} failed`),
				expectedCurrentStatuses: ['pending', 'running'],
			});
		}

		const attempt1Canary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [lane('retry-canary', PR_REVIEW_BASE_DIMENSION_IDS[2]!)],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt1Canary.success).toBe(true);
		const attempt1CanaryRecord = findByBatchId(
			directory,
			String(attempt1Canary.batch_id),
			{ parentSessionId: SESSION_ID },
		)[0];
		await appendSuccessfulBaseTransition(attempt1CanaryRecord!);
		const attempt1State = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(
			attempt1State?.prReviewResilience?.attempts[1]?.targetDimensions,
		).toEqual([
			PR_REVIEW_BASE_DIMENSION_IDS[2],
			PR_REVIEW_BASE_DIMENSION_IDS[3],
		]);

		liveSessionIds.delete(String(attempt0CanaryRecord?.subagentSessionId));
		await appendDelegationTransition(
			directory,
			attempt0CanaryRecord!.correlationId,
			{
				status: 'error',
				result: terminalErrorResult(
					'attempt 0 canary failed after attempt 1 canary succeeded',
				),
				expectedCurrentStatuses: ['pending', 'running'],
			},
		);

		const blockedAttempt2 = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('attempt-2-blocked', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(blockedAttempt2.success).toBe(false);
		expect(String(blockedAttempt2.message)).toContain(
			'requires its fanout batch before a later retry attempt',
		);

		const attempt1Fanout = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'fanout',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [lane('retry-fanout-0', PR_REVIEW_BASE_DIMENSION_IDS[3]!)],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt1Fanout.success).toBe(true);
		const attempt1FanoutRecord = findByBatchId(
			directory,
			String(attempt1Fanout.batch_id),
			{ parentSessionId: SESSION_ID },
		)[0];
		await appendDelegationTransition(
			directory,
			attempt1FanoutRecord!.correlationId,
			{
				status: 'error',
				result: terminalErrorResult(
					`retry fanout ${attempt1FanoutRecord!.laneId} failed`,
				),
				expectedCurrentStatuses: ['pending', 'running'],
			},
		);

		const attempt2Canary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('attempt-2-allowed', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt2Canary.success).toBe(true);
		const finalState = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(
			finalState?.prReviewResilience?.attempts[2]?.targetDimensions,
		).toEqual([
			PR_REVIEW_BASE_DIMENSION_IDS[0],
			PR_REVIEW_BASE_DIMENSION_IDS[3],
		]);
		expect(created).toBe(9);
	});

	test('late older failures re-enter the next retry target when the later successful canary has no fanout left', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const liveSessionIds = new Set<string>();
		gateInternals.getSessionOps = () =>
			({
				status: mock(async () => ({
					data: Object.fromEntries(
						[...liveSessionIds].map((sessionId) => [
							sessionId,
							{ type: 'busy' },
						]),
					),
				})),
			}) as ReturnType<typeof originalGateGetSessionOps>;

		const { record: attempt0CanaryRecord, state: attempt0State } =
			await dispatchAttempt0LiveCanary();
		gateInternals.nowMs = () =>
			Date.parse(
				attempt0State?.prReviewResilience?.attempts[0]?.admittedAt ?? '',
			) + 300_001;
		liveSessionIds.add(String(attempt0CanaryRecord?.subagentSessionId));

		const attempt0Fanout = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'fanout',
				pr_review_wave_attempt: 0,
				max_concurrent: 5,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.slice(1).map(
					(workflowLane, index) =>
						lane(`singleton-fanout-${index}`, workflowLane!),
				),
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt0Fanout.success).toBe(true);
		for (const record of findByBatchId(
			directory,
			String(attempt0Fanout.batch_id),
			{
				parentSessionId: SESSION_ID,
			},
		)) {
			if (record.laneId === 'singleton-fanout-1') {
				await appendDelegationTransition(directory, record.correlationId, {
					status: 'error',
					result: terminalErrorResult(`fanout ${record.laneId} failed`),
					expectedCurrentStatuses: ['pending', 'running'],
				});
				continue;
			}
			await appendSuccessfulBaseTransition(record);
		}

		const attempt1Canary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [
					lane('singleton-retry-canary', PR_REVIEW_BASE_DIMENSION_IDS[2]!),
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt1Canary.success).toBe(true);
		const attempt1CanaryRecord = findByBatchId(
			directory,
			String(attempt1Canary.batch_id),
			{ parentSessionId: SESSION_ID },
		)[0];
		await appendSuccessfulBaseTransition(attempt1CanaryRecord!);
		const attempt1State = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(
			attempt1State?.prReviewResilience?.attempts[1]?.targetDimensions,
		).toEqual([PR_REVIEW_BASE_DIMENSION_IDS[2]]);

		liveSessionIds.delete(String(attempt0CanaryRecord?.subagentSessionId));
		await appendDelegationTransition(
			directory,
			attempt0CanaryRecord!.correlationId,
			{
				status: 'error',
				result: terminalErrorResult(
					'attempt 0 canary failed after singleton retry canary succeeded',
				),
				expectedCurrentStatuses: ['pending', 'running'],
			},
		);

		const attempt2Canary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('singleton-late-retry', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(attempt2Canary.success).toBe(true);
		const finalState = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(
			finalState?.prReviewResilience?.attempts[2]?.targetDimensions,
		).toEqual([PR_REVIEW_BASE_DIMENSION_IDS[0]]);
		expect(created).toBe(8);
	});
});
