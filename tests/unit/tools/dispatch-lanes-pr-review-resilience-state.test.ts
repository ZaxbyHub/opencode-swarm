import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	appendDelegationTransition,
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
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

function terminalErrorResult(error: string) {
	return {
		error,
		text: `[ERROR] ${error}`,
		chars: error.length + 8,
		truncated: false,
		digest: `digest-${error.length}`,
		// Issue #2382: only lanes settled with the structured provider
		// classification contribute to the circuit — tests inject exactly what
		// the settle path now persists.
		terminalErrorClass: {
			kind: 'provider' as const,
			category: 'provider.rate_limit',
			statusCode: 503,
			hostRetryable: true,
		},
	};
}

async function removeDelegationStore(root: string) {
	for (const filename of [
		BACKGROUND_DELEGATIONS_FILE,
		BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
		BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	]) {
		await fs.rm(path.join(root, '.swarm', filename), { force: true });
	}
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-state-');
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

describe('dispatch_lanes PR review resilience state', () => {
	test('correlates otherwise-identical 503 failures after normalizing volatile timestamps and ordinary request/session ids', async () => {
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
			{ sessionID: 'review-session-signatures' },
		);
		const firstRecord = findByBatchId(directory, String(firstWave.batch_id), {
			parentSessionId: 'review-session-signatures',
		})[0];
		await appendDelegationTransition(directory, firstRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult(
				'HTTP 503 upstream overloaded req ses_a session sess_a at 2026-08-23T14:15:16.123Z epoch=1724422516123',
			),
			expectedCurrentStatuses: ['pending', 'running'],
		});

		const secondWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [lane('canary-1', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
			},
			directory,
			{ sessionID: 'review-session-signatures' },
		);
		const secondRecord = findByBatchId(directory, String(secondWave.batch_id), {
			parentSessionId: 'review-session-signatures',
		})[0];
		await appendDelegationTransition(directory, secondRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult(
				'HTTP 503 upstream overloaded req ses_b session sess_b at 2026-08-23T19:45:01.999Z epoch=1724442301999',
			),
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
				lanes: [lane('canary-2', PR_REVIEW_BASE_DIMENSION_IDS[2]!)],
			},
			directory,
			{ sessionID: 'review-session-signatures' },
		);
		expect(blocked.success).toBe(false);
		expect(blocked.failure_class).toBe('circuit_open');
		const state = await readPrWorkflowGateState(
			directory,
			'review-session-signatures',
		);
		// Issue #2382: the circuit is a versioned v2 record; two distinct
		// provider-terminal lanes of the same provider class opened it.
		const circuit = state?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		expect(circuit?.providerClass).toBe('provider.rate_limit');
		expect(circuit?.contributors).toHaveLength(2);
		expect(created).toBe(2);
	});

	test('keeps a persisted circuit open even after contributing delegation records disappear and state reloads', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		for (const [attempt, dimension] of [0, 1].map((value, index) => [
			value as 0 | 1,
			PR_REVIEW_BASE_DIMENSION_IDS[index]!,
		])) {
			const wave = await executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:base',
					pr_head_sha: 'abc123',
					base_sha: 'def456',
					base_ref: 'origin/main',
					pr_review_wave_stage: 'canary',
					pr_review_wave_attempt: attempt,
					max_concurrent: 1,
					lanes: [lane(`canary-${attempt}`, dimension)],
				},
				directory,
				{ sessionID: 'review-session-monotonic-circuit' },
			);
			const record = findByBatchId(directory, String(wave.batch_id), {
				parentSessionId: 'review-session-monotonic-circuit',
			})[0];
			await appendDelegationTransition(directory, record!.correlationId, {
				status: 'error',
				result: terminalErrorResult(
					`HTTP 503 upstream overloaded request_id=req-${attempt} session_id=sess-${attempt} at 2026-08-23T1${attempt}:00:00.000Z epoch=172440000000${attempt}`,
				),
				expectedCurrentStatuses: ['pending', 'running'],
			});
		}

		const initiallyBlocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('canary-2', PR_REVIEW_BASE_DIMENSION_IDS[2]!)],
			},
			directory,
			{ sessionID: 'review-session-monotonic-circuit' },
		);
		expect(initiallyBlocked.failure_class).toBe('circuit_open');

		await removeDelegationStore(directory);
		gateInternals.resetTrackedStateCache();
		const reloadedState = await readPrWorkflowGateState(
			directory,
			'review-session-monotonic-circuit',
		);
		// Issue #2382: the versioned v2 circuit persists (and stays OPEN) even
		// when its contributing delegation records are gone.
		const reloadedCircuit = reloadedState?.prReviewResilience?.circuit;
		expect(reloadedCircuit?.version).toBe(2);
		expect(reloadedCircuit?.state).toBe('OPEN');
		expect(reloadedCircuit?.contributors).toHaveLength(2);

		const stillBlocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('canary-2-retry', PR_REVIEW_BASE_DIMENSION_IDS[2]!)],
			},
			directory,
			{ sessionID: 'review-session-monotonic-circuit' },
		);
		expect(stillBlocked.success).toBe(false);
		expect(stillBlocked.failure_class).toBe('circuit_open');
		expect(created).toBe(2);
	});

	test('opens the circuit when two distinct retry-wave lanes targeting the same dimension fail with the same provider class (issue #2382 distinct-lane threshold)', async () => {
		// Two DIFFERENT (batchId, laneId) pairs — canary-0 and canary-1 — target
		// the same dimension and both fail with the same provider class. Under
		// the issue's distinct-lane accounting those are two independent
		// failures, so the circuit opens before a third wave. (The genuinely
		// different property — ONE lane observed across repeated collections
		// counting once — is covered by the v2 open/close suite.)
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		for (const attempt of [0, 1] as const) {
			const wave = await executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:base',
					pr_head_sha: 'abc123',
					base_sha: 'def456',
					base_ref: 'origin/main',
					pr_review_wave_stage: 'canary',
					pr_review_wave_attempt: attempt,
					max_concurrent: 1,
					lanes: [lane(`canary-${attempt}`, PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
				},
				directory,
				{ sessionID: 'review-session-repeat-dimension' },
			);
			expect(wave.success).toBe(true);
			const record = findByBatchId(directory, String(wave.batch_id), {
				parentSessionId: 'review-session-repeat-dimension',
			})[0];
			await appendDelegationTransition(directory, record!.correlationId, {
				status: 'error',
				result: terminalErrorResult('HTTP 503 upstream overloaded'),
				expectedCurrentStatuses: ['pending', 'running'],
			});
		}

		const thirdWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 2,
				max_concurrent: 1,
				lanes: [lane('canary-2', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
			},
			directory,
			{ sessionID: 'review-session-repeat-dimension' },
		);
		expect(thirdWave.success).toBe(false);
		expect(thirdWave.failure_class).toBe('circuit_open');
		expect(created).toBe(2);
	});
});
