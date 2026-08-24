import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

function lane(id: string, workflowLane: string, ownedWorkflowLanes?: string[]) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: workflowLane,
		...(ownedWorkflowLanes ? { owned_workflow_lanes: ownedWorkflowLanes } : {}),
	};
}

function fullWave(prefix: string) {
	return PR_REVIEW_BASE_DIMENSION_IDS.map((dimension, index) =>
		lane(`${prefix}-${index}`, dimension),
	);
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

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-followups-');
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
			pr_review_resilience: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
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

describe('dispatch_lanes PR review resilience follow-ups', () => {
	test('rolls back a staged canary admission when session.create fails before any child record exists', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => {
				created++;
				return { error: 'upstream create unavailable' };
			}),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const failed = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('rollback-canary-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session-rollback' },
		);
		expect(failed.success).toBe(false);
		expect(failed.failed).toBe(1);
		expect(created).toBe(1);
		expect(
			findByBatchId(directory, String(failed.batch_id), {
				parentSessionId: 'review-session-rollback',
			}),
		).toHaveLength(0);
		const rolledBackState = await readPrWorkflowGateState(
			directory,
			'review-session-rollback',
		);
		expect(rolledBackState?.prReviewBaseDispatches ?? []).toHaveLength(0);
		expect(rolledBackState?.prReviewBaseDispatch).toBeUndefined();
		expect(rolledBackState?.prReviewResilience).toBeUndefined();

		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: 'recovered-canary-session' } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const retried = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('rollback-canary-1', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
			},
			directory,
			{ sessionID: 'review-session-rollback' },
		);
		expect(retried.success).toBe(true);
		const retriedState = await readPrWorkflowGateState(
			directory,
			'review-session-rollback',
		);
		expect(retriedState?.prReviewResilience?.attempts).toHaveLength(1);
		expect(retriedState?.prReviewResilience?.attempts[0]?.attempt).toBe(0);
		expect(retriedState?.prReviewBaseDispatches ?? []).toHaveLength(1);
	});

	test('keeps the first admitted enabled policy snapshot even if current config flips disabled later', async () => {
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
				lanes: [lane('snapshot-enabled-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session-enabled-snapshot' },
		);
		expect(firstWave.success).toBe(true);
		const firstRecord = findByBatchId(directory, String(firstWave.batch_id), {
			parentSessionId: 'review-session-enabled-snapshot',
		})[0];
		await appendDelegationTransition(directory, firstRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult(
				'create durable enabled snapshot and fail canary',
			),
			expectedCurrentStatuses: ['pending', 'running'],
		});

		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
		const secondWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [lane('snapshot-enabled-1', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
			},
			directory,
			{ sessionID: 'review-session-enabled-snapshot' },
		);
		expect(secondWave.success).toBe(true);
		const state = await readPrWorkflowGateState(
			directory,
			'review-session-enabled-snapshot',
		);
		expect(state?.prReviewResilience?.policy.enabled).toBe(true);
		expect(state?.prReviewResilience?.attempts).toHaveLength(2);
		expect(state?.prReviewResilience?.attempts[1]?.attempt).toBe(1);
		expect(created).toBe(2);
	});

	test('keeps the first admitted disabled policy snapshot even if current config flips enabled later', async () => {
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
					enabled: false,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const initialLegacyWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('legacy-disabled'),
			},
			directory,
			{ sessionID: 'review-session-disabled-snapshot' },
		);
		expect(initialLegacyWave.success).toBe(true);

		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const stagedBlocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane('disabled-snapshot-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!),
				],
			},
			directory,
			{ sessionID: 'review-session-disabled-snapshot' },
		);
		expect(stagedBlocked.success).toBe(false);
		expect(String(stagedBlocked.message)).toContain(
			'staged PR_REVIEW base dispatch is valid only when pr_review_resilience is enabled',
		);

		const secondLegacyWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('legacy-disabled-second'),
			},
			directory,
			{ sessionID: 'review-session-disabled-snapshot' },
		);
		expect(secondLegacyWave.success).toBe(true);
		const state = await readPrWorkflowGateState(
			directory,
			'review-session-disabled-snapshot',
		);
		expect(state?.prReviewResilience?.policy.enabled).toBe(false);
		expect(state?.prReviewResilience?.attempts).toEqual([]);
		expect(created).toBe(12);
	});
});
