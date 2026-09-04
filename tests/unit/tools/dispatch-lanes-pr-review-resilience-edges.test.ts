import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	appendDelegationTransition,
	findByBatchId,
	recordPendingDelegation,
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
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

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
const FIXED_ISO_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function lane(id: string, workflowLane: string, ownedWorkflowLanes?: string[]) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: workflowLane,
		...(ownedWorkflowLanes ? { owned_workflow_lanes: ownedWorkflowLanes } : {}),
	};
}

function terminalErrorResult(errorText: string) {
	const text = `[ERROR] ${errorText}`;
	return {
		text,
		error: errorText,
		chars: text.length,
		truncated: false,
		digest: createHash('sha256').update(text).digest('hex'),
	};
}

function terminalSuccessResult(text: string) {
	return {
		text,
		chars: text.length,
		truncated: false,
		digest: createHash('sha256').update(text).digest('hex'),
	};
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-edges-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
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
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
	dispatchInternals.loadPluginConfig = () =>
		({
			pr_review_legacy_transcript_compatibility: true,
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
	safeRmRecursive(directory);
});

describe('dispatch_lanes PR review resilience edges', () => {
	test('does not count completed non-empty canaries toward the correlated-failure circuit', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const firstWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('canary-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session-completed' },
		);
		expect(firstWave.success).toBe(true);
		const firstRecord = findByBatchId(directory, String(firstWave.batch_id), {
			parentSessionId: 'review-session-completed',
		})[0];
		await appendDelegationTransition(directory, firstRecord!.correlationId, {
			status: 'completed',
			result: terminalSuccessResult('[RESULT] candidate evidence ready'),
			expectedCurrentStatuses: ['pending'],
		});
		await recordPendingDelegation(directory, {
			correlationId: 'manual-canary-1',
			jobId: null,
			subagentSessionId: 'manual-canary-1',
			parentSessionId: 'review-session-completed',
			callID: 'manual-call-1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'manual-batch-1',
			laneId: 'manual-canary-1',
			mode: 'swarm-pr-review:base',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[1]!,
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		await appendDelegationTransition(directory, 'manual-canary-1', {
			status: 'completed',
			result: terminalSuccessResult('[RESULT] another healthy lane'),
			expectedCurrentStatuses: ['pending'],
		});
		await recordPendingDelegation(directory, {
			correlationId: 'manual-fanout-1',
			jobId: null,
			subagentSessionId: 'manual-fanout-1',
			parentSessionId: 'review-session-completed',
			callID: 'manual-call-fanout-1',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'manual-fanout-1',
			laneId: 'manual-fanout-1',
			mode: 'swarm-pr-review:base',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[2]!,
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: null,
				prHeadSha: 'abc123',
				scope: null,
			},
		});
		await appendDelegationTransition(directory, 'manual-fanout-1', {
			status: 'consumed',
			result: terminalSuccessResult('[RESULT] settled fanout'),
			expectedCurrentStatuses: ['pending'],
		});

		const current = await readPrWorkflowGateState(
			directory,
			'review-session-completed',
		);
		if (!current) throw new Error('missing active workflow state');
		const persistedState = structuredClone(current) as typeof current;
		persistedState.prReviewBaseDispatches ??= [];
		persistedState.prReviewResilience ??= {
			policy: { ...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG },
			attempts: [],
			status: 'healthy',
		};
		persistedState.prReviewBaseDispatches.push(
			{
				batchId: 'manual-batch-1',
				lanes: [
					{
						laneId: 'manual-canary-1',
						workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[1]!,
					},
				],
				validatedAt: FIXED_ISO_TIMESTAMP,
			},
			{
				batchId: 'manual-fanout-1',
				lanes: [
					{
						laneId: 'manual-fanout-1',
						workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[2]!,
					},
				],
				validatedAt: FIXED_ISO_TIMESTAMP,
			},
		);
		persistedState.prReviewResilience.attempts.push({
			attempt: 1,
			targetDimensions: [...PR_REVIEW_BASE_DIMENSION_IDS],
			canaryBatchId: 'manual-batch-1',
			canaryLaneId: 'manual-canary-1',
			canaryWorkflowLane: PR_REVIEW_BASE_DIMENSION_IDS[1]!,
			admittedAt: FIXED_ISO_TIMESTAMP,
			fanoutBatchId: 'manual-fanout-1',
		});
		await writeAuthoritativePrWorkflowState(directory, persistedState);
		gateInternals.resetTrackedStateCache();

		const thirdWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('canary-2', PR_REVIEW_BASE_DIMENSION_IDS[3]!)],
			},
			directory,
			{ sessionID: 'review-session-completed' },
		);
		expect(thirdWave.success).toBe(true);
		expect(created).toBe(2);
	});

	test('keeps the first staged resilience policy snapshot even if config reloads to stricter values later', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
					correlated_failure_threshold: 2,
					max_retry_attempts_after_initial: 2,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const firstWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('snapshot-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session-snapshot' },
		);
		expect(firstWave.success).toBe(true);
		const firstRecord = findByBatchId(directory, String(firstWave.batch_id), {
			parentSessionId: 'review-session-snapshot',
		})[0];
		await appendDelegationTransition(directory, firstRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult('HTTP 503 first canary failure'),
			expectedCurrentStatuses: ['pending', 'running'],
		});
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
					correlated_failure_threshold: 1,
					max_retry_attempts_after_initial: 0,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const retryWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [lane('snapshot-1', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
			},
			directory,
			{ sessionID: 'review-session-snapshot' },
		);
		expect(retryWave.success).toBe(true);
		expect(created).toBe(2);
		const state = await readPrWorkflowGateState(
			directory,
			'review-session-snapshot',
		);
		expect(state?.prReviewResilience?.policy).toEqual({
			enabled: true,
			canaryProbeMs: 300_000,
			statusProbeTimeoutMs: 2_000,
			correlatedFailureThreshold: 2,
			maxRetryAttemptsAfterInitial: 2,
			circuitOpenDurationMs: 60_000,
		});
	});

	test('fails closed before fanout child creation when the elapsed canary cannot be proven live via status', async () => {
		for (const scenario of [
			{
				sessionID: 'review-session-unavailable',
				reason: 'status probe unavailable',
				configure: () => {
					gateInternals.getSessionOps = () => null;
				},
			},
			{
				sessionID: 'review-session-no-data',
				reason: 'status probe returned no data',
				configure: () => {
					gateInternals.getSessionOps = () =>
						({
							status: mock(async () => ({ data: undefined, error: undefined })),
						}) as ReturnType<typeof originalGateGetSessionOps>;
				},
			},
		]) {
			let created = 0;
			dispatchInternals.getSessionOps = () => ({
				create: mock(async () => ({
					data: { id: `${scenario.sessionID}-lane-session-${created++}` },
				})),
				promptAsync: mock(async () => ({ data: undefined, error: undefined })),
				delete: mock(async () => undefined),
			});
			const canary = await executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:base',
					pr_head_sha: 'abc123',
					base_sha: 'def456',
					base_ref: 'origin/main',
					pr_review_wave_stage: 'canary',
					pr_review_wave_attempt: 0,
					max_concurrent: 1,
					lanes: [
						lane(
							`${scenario.sessionID}-canary`,
							PR_REVIEW_BASE_DIMENSION_IDS[0]!,
						),
					],
				},
				directory,
				{ sessionID: scenario.sessionID },
			);
			expect(canary.success).toBe(true);
			const state = await readPrWorkflowGateState(
				directory,
				scenario.sessionID,
			);
			gateInternals.nowMs = () =>
				Date.parse(state?.prReviewResilience?.attempts[0]?.admittedAt ?? '') +
				300_001;
			scenario.configure();

			const blocked = await executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:base',
					pr_head_sha: 'abc123',
					base_sha: 'def456',
					base_ref: 'origin/main',
					pr_review_wave_stage: 'fanout',
					pr_review_wave_attempt: 0,
					max_concurrent: 5,
					lanes: PR_REVIEW_BASE_DIMENSION_IDS.slice(1).map((dimension, index) =>
						lane(`${scenario.sessionID}-fanout-${index}`, dimension),
					),
				},
				directory,
				{ sessionID: scenario.sessionID },
			);
			expect(blocked.success).toBe(false);
			expect(String(blocked.message)).toContain(scenario.reason);
			expect(created).toBe(1);
			gateInternals.nowMs = originalNowMs;
		}
	});

	test('rejects skipped retry ordinals for staged canaries', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const firstWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('gap-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session-gap' },
		);
		expect(firstWave.success).toBe(true);
		const firstRecord = findByBatchId(directory, String(firstWave.batch_id), {
			parentSessionId: 'review-session-gap',
		})[0];
		await appendDelegationTransition(directory, firstRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult('HTTP 503 skipped ordinal failure'),
			expectedCurrentStatuses: ['pending', 'running'],
		});

		const blocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('gap-2', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
			},
			directory,
			{ sessionID: 'review-session-gap' },
		);
		expect(blocked.success).toBe(false);
		expect(blocked.failure_class).toBe('retry_exhausted');
		expect(String(blocked.message)).toContain(
			'allows attempt 0 plus at most 2 retry attempts',
		);
		expect(created).toBe(1);
	});
});
