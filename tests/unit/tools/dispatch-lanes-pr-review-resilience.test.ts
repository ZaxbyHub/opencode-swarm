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

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-');
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

describe('dispatch_lanes PR review resilience', () => {
	test('snapshots the staged policy, carries unresolved obligations forward, and opens a typed correlated-failure circuit before a third launch', async () => {
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
			{ sessionID: 'review-session' },
		);
		expect(firstWave.success).toBe(true);
		expect(firstWave.batch_id).toBeDefined();
		const firstState = await readPrWorkflowGateState(
			directory,
			'review-session',
		);
		expect(firstState?.prReviewResilience?.policy).toEqual({
			enabled: true,
			canaryProbeMs: 300_000,
			statusProbeTimeoutMs: 2_000,
			correlatedFailureThreshold: 2,
			maxRetryAttemptsAfterInitial: 2,
			circuitOpenDurationMs: 60_000,
		});
		expect(firstState?.prReviewResilience?.attempts).toHaveLength(1);
		expect(firstState?.prReviewResilience?.attempts[0]?.attempt).toBe(0);
		expect(
			firstState?.prReviewResilience?.attempts[0]?.targetDimensions,
		).toEqual(PR_REVIEW_BASE_DIMENSION_IDS);
		expect(
			firstState?.prReviewResilience?.attempts[0]?.canaryWorkflowLane,
		).toBe(PR_REVIEW_BASE_DIMENSION_IDS[0]);

		const firstRecord = findByBatchId(directory, String(firstWave.batch_id), {
			parentSessionId: 'review-session',
		})[0];
		expect(firstRecord?.correlationId).toBeDefined();
		await appendDelegationTransition(directory, firstRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult(
				'HTTP 503 upstream overloaded request_id=req-111 session_id=sess-111 at 2026-08-23T14:15:16.123Z epoch=1724422516123',
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
			{ sessionID: 'review-session' },
		);
		expect(secondWave.success).toBe(true);
		const secondState = await readPrWorkflowGateState(
			directory,
			'review-session',
		);
		expect(secondState?.prReviewResilience?.attempts).toHaveLength(2);
		expect(secondState?.prReviewResilience?.attempts[1]?.attempt).toBe(1);
		expect(
			secondState?.prReviewResilience?.attempts[1]?.targetDimensions,
		).toEqual(PR_REVIEW_BASE_DIMENSION_IDS);

		const secondRecord = findByBatchId(directory, String(secondWave.batch_id), {
			parentSessionId: 'review-session',
		})[0];
		expect(secondRecord?.correlationId).toBeDefined();
		await appendDelegationTransition(directory, secondRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult(
				'HTTP 503 upstream overloaded request_id=req-222 session_id=sess-222 at 2026-08-23T19:45:01.999Z epoch=1724442301999',
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
			{ sessionID: 'review-session' },
		);
		expect(blocked.success).toBe(false);
		expect(blocked.failure_class).toBe('circuit_open');
		expect(String(blocked.message)).toContain('circuit is OPEN');
		expect(created).toBe(2);

		const blockedState = await readPrWorkflowGateState(
			directory,
			'review-session',
		);
		// Issue #2382: two distinct provider-terminal lanes of the same provider
		// class opened a versioned v2 OPEN circuit.
		const circuit = blockedState?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		expect(circuit?.providerClass).toBe('provider.rate_limit');
		expect(circuit?.contributors).toHaveLength(2);
		expect(circuit?.contributors?.[0]?.batchId).not.toBe(
			circuit?.contributors?.[1]?.batchId,
		);
		expect(circuit?.openedAt).toBeDefined();
		expect(circuit?.openUntil).toBeDefined();
	});

	test('rejects a tier-M attempt-0 fanout whose combined canary+fanout lane count falls below the floor before launching any new lane', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 400,
			changedFiles: 12,
		});
		gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
			gateInternals.resolvePrReviewDiffStats(...args);

		const canary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('canary-m', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session' },
		);
		expect(canary.success).toBe(true);
		const canaryRecord = findByBatchId(directory, String(canary.batch_id), {
			parentSessionId: 'review-session',
		})[0];
		const state = await readPrWorkflowGateState(directory, 'review-session');
		const admittedAtMs = Date.parse(
			state?.prReviewResilience?.attempts[0]?.admittedAt ?? '',
		);
		gateInternals.nowMs = () => admittedAtMs + 300_001;
		gateInternals.getSessionOps = () =>
			({
				status: mock(async () => ({
					data: {
						[String(canaryRecord?.subagentSessionId)]: { type: 'busy' },
					},
				})),
			}) as ReturnType<typeof originalGateGetSessionOps>;

		const blocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'fanout',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane('fanout-m', PR_REVIEW_BASE_DIMENSION_IDS[1]!, [
						PR_REVIEW_BASE_DIMENSION_IDS[1]!,
						PR_REVIEW_BASE_DIMENSION_IDS[2]!,
						PR_REVIEW_BASE_DIMENSION_IDS[3]!,
						PR_REVIEW_BASE_DIMENSION_IDS[4]!,
						PR_REVIEW_BASE_DIMENSION_IDS[5]!,
					]),
				],
			},
			directory,
			{ sessionID: 'review-session' },
		);
		expect(blocked.success).toBe(false);
		expect(String(blocked.message)).toContain(
			'at least 3 combined canary+fanout lanes',
		);
		expect(created).toBe(1);
	});

	test('rejects staged wave fields when pr_review_resilience is disabled', async () => {
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: 'lane-session' } })),
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

		const blocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('disabled-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			},
			directory,
			{ sessionID: 'review-session' },
		);
		expect(blocked.success).toBe(false);
		expect(blocked.failure_class).toBe('invalid_args');
		expect(String(blocked.message)).toContain(
			'pr_review_resilience is enabled',
		);
	});

	test('the default flip changes tier-L gate behavior: staged admission is required only when explicitly enabled (issue #2381)', async () => {
		// DIFFERENTIAL test with a positive control. An earlier version of this
		// asserted only that the default-config dispatch lacked the
		// "requires canary-first" message — which passed VACUOUSLY, because the
		// dispatch failed earlier at `no_client` and never reached the resilience
		// gate at all, so the negative assertion held trivially.
		//
		// The meaningful claim is a DIFFERENCE in gate behavior for one identical
		// dispatch. The positive control below proves the gate is reachable and does
		// block when resilience is enabled; the default case then proves it no
		// longer does. Its failure is the downstream `no_client`, which is itself
		// the evidence that it got PAST the resilience gate.
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `flip-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const dispatchArgs = {
			mode: 'swarm-pr-review:base' as const,
			pr_head_sha: 'abc123',
			base_sha: 'def456',
			base_ref: 'origin/main',
			// Tier L in this harness: six singleton lanes, max_concurrent 6.
			max_concurrent: 6,
			lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((dimension, index) =>
				lane(`legacy-${index}`, dimension),
			),
		};

		// POSITIVE CONTROL: explicitly enabled -> the gate blocks a dispatch that
		// carries no stage metadata.
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
		const enabled = await executeDispatchLanesAsync(dispatchArgs, directory, {
			sessionID: 'review-session-enabled',
		});
		expect(enabled.success).toBe(false);
		expect(enabled.failure_class).toBe('invalid_args');
		expect(String(enabled.message)).toContain('canary-first');

		// DEFAULT (no config at all): the same dispatch is no longer gated on staged
		// admission — it is ADMITTED and launches all six lanes. (An earlier draft
		// of this test asserted only that it failed later at `no_client`; that
		// passed vacuously, because the dispatch died before ever reaching the
		// resilience gate. The positive control above plus the topology assertions
		// below are what make the default case a real claim.)
		dispatchInternals.loadPluginConfig = () =>
			({}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
		const defaulted = await executeDispatchLanesAsync(dispatchArgs, directory, {
			sessionID: 'review-session-default',
		});
		expect(defaulted.failure_class).not.toBe('invalid_args');
		expect(String(defaulted.message ?? '')).not.toContain('canary-first');
		// PR-review FB-4: admission alone is not the claim — assert the TOPOLOGY.
		// `success: true` only says the async dispatch started without an
		// invalid_args/no_client failure; it says nothing about how many lanes were
		// actually launched. A bug that admitted the call but collapsed six lanes
		// into one wave would pass without this.
		expect(created).toBe(dispatchArgs.lanes.length);
		expect(defaulted.dispatched).toBe(dispatchArgs.lanes.length);
		// It is ADMITTED: the legacy one-wave base dispatch now succeeds where
		// the enabled policy would have demanded canary/fanout staging.
		expect(defaulted.success).toBe(true);
	});
});
