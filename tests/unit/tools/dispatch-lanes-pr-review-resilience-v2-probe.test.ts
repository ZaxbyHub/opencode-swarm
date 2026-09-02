/**
 * Issue #2382 — probe lifecycle behavior through the real dispatch entry:
 * after the open interval elapses, exactly one staged dispatch is admitted as
 * the HALF_OPEN probe; a typed provider failure reopens; a typed success
 * closes with a generation bump and evidence waterline; a stale-generation
 * success can never close the current circuit.
 */
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

// Short open interval so the test clock only has to step a little.
const OPEN_DURATION_MS = 1_000;

function lane(id: string, workflowLane: string) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: workflowLane,
	};
}

function providerResult(text: string) {
	return {
		text: `[ERROR] ${text}`,
		error: text,
		chars: text.length + 8,
		truncated: false,
		digest: createHash('sha256').update(text).digest('hex'),
		terminalErrorClass: {
			kind: 'provider' as const,
			category: 'provider.rate_limit',
			statusCode: 503,
			hostRetryable: true,
		},
	};
}

function successResult(text: string) {
	return {
		text,
		chars: text.length,
		truncated: false,
		digest: createHash('sha256').update(text).digest('hex'),
	};
}

const stagedDispatch = (
	sessionID: string,
	attempt: 0 | 1 | 2,
	laneId: string,
) => ({
	mode: 'swarm-pr-review:base' as const,
	pr_head_sha: 'abc123',
	base_sha: 'def456',
	base_ref: 'origin/main',
	pr_review_wave_stage: 'canary' as const,
	pr_review_wave_attempt: attempt,
	max_concurrent: 1,
	lanes: [
		lane(
			laneId,
			PR_REVIEW_BASE_DIMENSION_IDS[attempt === 0 ? 0 : attempt === 1 ? 1 : 2]!,
		),
	],
});

function mockLauncher(counter: { created: number }) {
	return () => ({
		create: mock(async () => ({
			data: { id: `probe-session-${counter.created++}` },
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-v2probe-');
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
				circuit_open_duration_ms: OPEN_DURATION_MS,
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

/** Drives the workflow to an OPEN circuit after two provider-failed canaries. */
async function openCircuit(sessionID: string, counter: { created: number }) {
	const launcher = mockLauncher(counter);
	for (const attempt of [0, 1] as const) {
		dispatchInternals.getSessionOps = launcher;
		const wave = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, attempt, `probe-canary-${attempt}`),
			directory,
			{ sessionID },
		);
		expect(wave.success).toBe(true);
		const record = findByBatchId(directory, String(wave.batch_id), {
			parentSessionId: sessionID,
		})[0];
		await appendDelegationTransition(directory, record!.correlationId, {
			status: 'error',
			result: providerResult(`HTTP 503 upstream overloaded ${attempt}`),
			expectedCurrentStatuses: ['pending', 'running'],
		});
	}
	dispatchInternals.getSessionOps = launcher;
	const blocked = await executeDispatchLanesAsync(
		stagedDispatch(sessionID, 2, 'probe-canary-2'),
		directory,
		{ sessionID },
	);
	expect(blocked.failure_class).toBe('circuit_open');
	const openState = await readPrWorkflowGateState(directory, sessionID);
	expect(openState?.prReviewResilience?.circuit?.version).toBe(2);
	expect(openState?.prReviewResilience?.circuit?.state).toBe('OPEN');
	return openState!;
}

describe('dispatch_lanes PR review resilience v2 probe lifecycle (issue #2382)', () => {
	test('expiry admits exactly one probe; probe success closes with a generation bump and waterline', async () => {
		const sessionID = 'probe-success-cycle';
		const counter = { created: 0 };
		const openState = await openCircuit(sessionID, counter);
		expect(counter.created).toBe(2);

		// Before expiry: still blocked, no probe admitted. The clock is frozen
		// 1ms before the persisted openUntil (PRR-004: real-wall jitter between
		// the open stamp and this check must not be able to flip the branch).
		const openUntilMs = Date.parse(
			openState?.prReviewResilience?.circuit?.openUntil ?? '',
		);
		gateInternals.nowMs = () => openUntilMs - 1;
		const early = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-early'),
			directory,
			{ sessionID },
		);
		expect(early.failure_class).toBe('circuit_open');
		expect(counter.created).toBe(2);

		// After expiry: the staged dispatch is admitted as THE probe. The seam
		// is stepped relative to the persisted openUntil, so this file never
		// touches the real clock directly (test-clock lint, issue #1782).
		const steppedNowMs = () => openUntilMs + OPEN_DURATION_MS + 1;
		gateInternals.nowMs = steppedNowMs;
		const probeWave = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-canary-2'),
			directory,
			{ sessionID },
		);
		expect(probeWave.success).toBe(true);
		expect(counter.created).toBe(3);
		const halfOpenState = await readPrWorkflowGateState(directory, sessionID);
		const halfOpenCircuit = halfOpenState?.prReviewResilience?.circuit;
		expect(halfOpenCircuit?.state).toBe('HALF_OPEN');
		expect(halfOpenCircuit?.probe?.batchId).toBe(String(probeWave.batch_id));
		expect(halfOpenState?.prReviewResilience?.attempts).toHaveLength(3);

		// A concurrent contender is blocked (the probe slot is taken) and did
		// not launch a child.
		const contender = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-contender'),
			directory,
			{ sessionID },
		);
		expect(contender.success).toBe(false);
		expect(counter.created).toBe(3);

		// The probe lane settles successfully: the next enforcement closes the
		// circuit (generation bump, evidence waterline) even though the staged
		// retry budget is exhausted.
		const probeRecord = findByBatchId(directory, String(probeWave.batch_id), {
			parentSessionId: sessionID,
		})[0];
		await appendDelegationTransition(directory, probeRecord!.correlationId, {
			status: 'completed',
			result: successResult('clean findings from the recovery probe'),
			expectedCurrentStatuses: ['pending', 'running'],
		});
		const afterSuccess = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-after-success'),
			directory,
			{ sessionID },
		);
		expect(afterSuccess.success).toBe(false);
		gateInternals.nowMs = originalNowMs;
		const closedState = await readPrWorkflowGateState(directory, sessionID);
		const circuit = closedState?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('CLOSED');
		expect(circuit?.generation).toBe(2);
		expect(circuit?.contributors).toHaveLength(0);
		expect(circuit?.evidenceWaterline).toBeDefined();
		expect(circuit?.probe).toBeUndefined();
	});

	test('probe typed provider failure reopens with a new interval and appends its contributor', async () => {
		const sessionID = 'probe-failure-reopen';
		const counter = { created: 0 };
		await openCircuit(sessionID, counter);

		const steppedNowMs = () => originalNowMs() + OPEN_DURATION_MS + 1;
		gateInternals.nowMs = steppedNowMs;
		const probeWave = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-canary-2'),
			directory,
			{ sessionID },
		);
		expect(probeWave.success).toBe(true);

		const probeRecord = findByBatchId(directory, String(probeWave.batch_id), {
			parentSessionId: sessionID,
		})[0];
		await appendDelegationTransition(directory, probeRecord!.correlationId, {
			status: 'error',
			result: providerResult('HTTP 503 the probe died too'),
			expectedCurrentStatuses: ['pending', 'running'],
		});

		const afterReopen = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-after-reopen'),
			directory,
			{ sessionID },
		);
		gateInternals.nowMs = originalNowMs;
		expect(afterReopen.failure_class).toBe('circuit_open');
		const reopenedState = await readPrWorkflowGateState(directory, sessionID);
		const circuit = reopenedState?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		expect(circuit?.generation).toBe(1);
		expect(circuit?.contributors).toHaveLength(3);
		expect(circuit?.probe).toBeUndefined();
		expect(
			circuit?.contributors?.some(
				(entry) => entry.batchId === String(probeWave.batch_id),
			),
		).toBe(true);
	});

	test('a completed record for a batch other than the CURRENT probe cannot close the circuit', async () => {
		const sessionID = 'probe-stale-generation';
		const counter = { created: 0 };
		await openCircuit(sessionID, counter);

		const steppedNowMs = () => originalNowMs() + OPEN_DURATION_MS + 1;
		gateInternals.nowMs = steppedNowMs;
		const probeWave = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-canary-2'),
			directory,
			{ sessionID },
		);
		expect(probeWave.success).toBe(true);
		const currentProbeBatchId = String(probeWave.batch_id);

		// The recorded CURRENT probe has no terminal record (the observer
		// deadline the test budget models never settled it), and no other
		// batch's outcome is consulted: the machine honors outcomes only for
		// the recorded probe, so the circuit can neither close nor reopen — it
		// stays HALF_OPEN and blocks, exactly the stale-generation guard.
		const after = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-stale-check'),
			directory,
			{ sessionID },
		);
		gateInternals.nowMs = originalNowMs;
		expect(after.success).toBe(false);
		const state = await readPrWorkflowGateState(directory, sessionID);
		const circuit = state?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('HALF_OPEN');
		expect(circuit?.generation).toBe(1);
		expect(circuit?.probe?.batchId).toBe(currentProbeBatchId);
	});

	test('rolling back an unlaunched probe admission ends the probe lifecycle without wedging the circuit (issue #2382 review PRR-002)', async () => {
		const sessionID = 'probe-rollback-recovery';
		const counter = { created: 0 };
		await openCircuit(sessionID, counter);

		// Step past expiry and make session.create fail for the probe admission:
		// the launcher records nothing, so the internal rollback fires with the
		// probe batch as the tail batch and zero delegation records.
		const steppedNowMs = () => originalNowMs() + OPEN_DURATION_MS + 1;
		gateInternals.nowMs = steppedNowMs;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ error: 'upstream create unavailable' })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const failedProbe = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-canary-2'),
			directory,
			{ sessionID },
		);
		expect(failedProbe.success).toBe(false);

		// The rollback must end the probe lifecycle: circuit back to OPEN with a
		// restarted cooldown, probe cleared, and the attempt ledger rolled back.
		const afterRollback = await readPrWorkflowGateState(directory, sessionID);
		const circuit = afterRollback?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		expect(circuit?.probe).toBeUndefined();
		expect(circuit?.openUntil).toBeDefined();
		expect(afterRollback?.prReviewResilience?.attempts).toHaveLength(2);
		expect(
			afterRollback?.prReviewBaseDispatches.some(
				(batch) => batch.batchId === String(failedProbe.batch_id),
			),
		).toBe(false);

		// Recovery is automatic: a later admission becomes a fresh probe.
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({
				data: { id: `probe-recovery-${counter.created++}` },
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		gateInternals.nowMs = () => originalNowMs() + 2 * (OPEN_DURATION_MS + 1);
		const freshProbe = await executeDispatchLanesAsync(
			stagedDispatch(sessionID, 2, 'probe-canary-2-retry'),
			directory,
			{ sessionID },
		);
		expect(freshProbe.success).toBe(true);
		const recovered = await readPrWorkflowGateState(directory, sessionID);
		expect(recovered?.prReviewResilience?.circuit?.state).toBe('HALF_OPEN');
		expect(recovered?.prReviewResilience?.circuit?.probe?.batchId).toBe(
			String(freshProbe.batch_id),
		);
		gateInternals.nowMs = originalNowMs;
	});
});
