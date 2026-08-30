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
		// Issue #2382: tests inject exactly what the settle path now persists.
		terminalErrorClass: {
			kind: 'provider' as const,
			category: 'provider.rate_limit',
			statusCode: 503,
			hostRetryable: true,
		},
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

	test('current-config disable immediately disarms an already-admitted workflow (issue #2382 authoritative live disable)', async () => {
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

		// Current config flips DISABLED: the persisted enabled snapshot must NOT
		// keep resilience semantics alive (the pre-#2382 behavior this test used
		// to pin). Staged dispatch is no longer even valid, and a legacy one-wave
		// dispatch proceeds without resilience gating.
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const stagedWhileDisabled = await executeDispatchLanesAsync(
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
		expect(stagedWhileDisabled.success).toBe(false);
		expect(stagedWhileDisabled.failure_class).toBe('invalid_args');
		expect(String(stagedWhileDisabled.message)).toContain(
			'staged PR_REVIEW base dispatch is valid only when pr_review_resilience is enabled',
		);

		const legacyWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('legacy-after-disable'),
			},
			directory,
			{ sessionID: 'review-session-enabled-snapshot' },
		);
		expect(legacyWave.success).toBe(true);

		const state = await readPrWorkflowGateState(
			directory,
			'review-session-enabled-snapshot',
		);
		// The persisted record survives for audit, marked disabled; the attempt
		// ledger and (nonexistent) circuit are untouched by the disable.
		expect(state?.prReviewResilience?.policy.enabled).toBe(false);
		expect(state?.prReviewResilience?.attempts).toHaveLength(1);
		expect(state?.prReviewResilience?.circuit).toBeUndefined();
		expect(created).toBe(1 + 6);
	});

	test('re-enabling starts from a clean v2 CLOSED generation and never resurrects pre-disable evidence (issue #2382)', async () => {
		// Seed a workflow whose persisted resilience record was last observed
		// disabled, with an OPEN circuit carrying pre-disable evidence.
		const sessionID = 'review-session-re-enable';
		const statePath = path.join(
			directory,
			'.swarm',
			gateInternals.workflowGateStateRelativePath(sessionID),
		);
		await fs.mkdir(path.dirname(statePath), { recursive: true });
		await fs.writeFile(
			statePath,
			JSON.stringify({
				schemaVersion: 1,
				revision: 3,
				sessionID,
				mode: 'PR_REVIEW',
				activatedAt: '2026-08-23T01:00:00.000Z',
				updatedAt: '2026-08-23T02:00:00.000Z',
				prHeadSha: 'abc123',
				prReviewBaseRef: 'origin/main',
				prReviewBaseSha: 'def456',
				prReviewDepthTier: 'M',
				prReviewDiffStats: {
					changedLines: 2_000,
					changedFiles: 60,
					hasSubmoduleChange: false,
				},
				prReviewResilience: {
					policy: {
						enabled: false,
						canaryProbeMs: 300_000,
						statusProbeTimeoutMs: 2_000,
						correlatedFailureThreshold: 2,
						maxRetryAttemptsAfterInitial: 2,
						circuitOpenDurationMs: 60_000,
					},
					attempts: [],
					circuit: {
						version: 2,
						state: 'OPEN',
						generation: 1,
						providerClass: 'provider.rate_limit',
						contributors: [
							{
								batchId: 'pre-disable-batch',
								laneId: 'pre-disable-lane-0',
								terminalAt: '2026-08-23T01:30:00.000Z',
							},
							{
								batchId: 'pre-disable-batch',
								laneId: 'pre-disable-lane-1',
								terminalAt: '2026-08-23T01:31:00.000Z',
							},
						],
						openedAt: '2026-08-23T01:32:00.000Z',
						openUntil: '2026-08-23T01:33:00.000Z',
					},
				},
			}),
			'utf-8',
		);
		gateInternals.resetTrackedStateCache();

		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({
				data: { id: `re-enable-session-${created++}` },
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		// Re-enable in config: the very next staged dispatch must start from a
		// clean v2 CLOSED generation — the OPEN circuit and its pre-disable
		// contributors are discarded (waterline = now), and the canary is
		// admitted rather than blocked by resurrected evidence.
		const canary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('re-enable-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID },
		);
		expect(canary.success).toBe(true);

		const state = await readPrWorkflowGateState(directory, sessionID);
		expect(state?.prReviewResilience?.policy.enabled).toBe(true);
		expect(state?.prReviewResilience?.attempts).toHaveLength(1);
		const circuit = state?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('CLOSED');
		expect(circuit?.generation).toBe(2);
		expect(circuit?.contributors).toHaveLength(0);
		expect(circuit?.evidenceWaterline).toBeDefined();
		expect(circuit?.probe).toBeUndefined();
		expect(created).toBe(1);
	});
});
