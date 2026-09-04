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
	withSessionStateMutation,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
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

function lane(id: string, workflowLane: string) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: workflowLane,
	};
}

function fullWave(prefix: string) {
	return PR_REVIEW_BASE_DIMENSION_IDS.map((dimension, index) =>
		lane(`${prefix}-${index}`, dimension),
	);
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

async function removeDelegationStore(root: string) {
	for (const filename of [
		BACKGROUND_DELEGATIONS_FILE,
		BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
		BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	]) {
		await fs.rm(path.join(root, '.swarm', filename), { force: true });
	}
}

async function writeWorkflowGateState(
	sessionID: string,
	transform: (
		current: NonNullable<Awaited<ReturnType<typeof readPrWorkflowGateState>>>,
	) => NonNullable<Awaited<ReturnType<typeof readPrWorkflowGateState>>>,
) {
	await withSessionStateMutation(directory, sessionID, async () => {
		const current = await readPrWorkflowGateState(directory, sessionID);
		if (!current) throw new Error('missing active workflow state');
		await writeStateWhileLocked(directory, transform(current));
	});
	gateInternals.resetTrackedStateCache();
}

async function clearDelegationCheckpointArtifacts(root: string) {
	for (const filename of [
		BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
		BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	]) {
		await fs.rm(path.join(root, '.swarm', filename), { force: true });
	}
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-circuit-');
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
				enabled: false,
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

describe('dispatch_lanes PR review resilience circuit bounds', () => {
	test('migrates a persisted legacy circuit once to a nonblocking v2 CLOSED record; pre-upgrade evidence never reopens it (issue #2382)', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'review-session-circuit-migration';
		const seedWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('legacy-circuit-seed'),
			},
			directory,
			{ sessionID },
		);
		expect(seedWave.success).toBe(true);
		expect(created).toBe(6);

		const seedState = await readPrWorkflowGateState(directory, sessionID);
		const seedBatch = seedState?.prReviewBaseDispatches?.[0];
		const seedRecords = findByBatchId(directory, String(seedWave.batch_id), {
			parentSessionId: sessionID,
		});
		expect(seedBatch).toBeDefined();
		expect(seedRecords).toHaveLength(PR_REVIEW_BASE_DIMENSION_IDS.length);

		const seededBatches = Array.from({ length: 22 }, (_, batchIndex) => ({
			batchId: `legacy-circuit-batch-${batchIndex}`,
			lanes:
				seedBatch?.lanes.map((batchLane, laneIndex) => ({
					...batchLane,
					laneId: `legacy-circuit-lane-${batchIndex}-${laneIndex}`,
				})) ?? [],
			validatedAt: `2026-08-23T00:${String(batchIndex).padStart(2, '0')}:00.000Z`,
		}));
		const terminalResult = terminalErrorResult('HTTP 503 upstream overloaded');
		const seededRecords = seededBatches.flatMap((batch, batchIndex) =>
			batch.lanes.map((batchLane, laneIndex) => {
				const template = seedRecords[laneIndex]!;
				const timestamp = 1_000 + batchIndex * 10 + laneIndex;
				const correlationId = `legacy-circuit-corr-${batchIndex}-${laneIndex}`;
				return {
					...template,
					correlationId,
					jobId: null,
					subagentSessionId: correlationId,
					status: 'error' as const,
					createdAt: timestamp,
					updatedAt: timestamp,
					batchId: batch.batchId,
					laneId: batchLane.laneId,
					mode: 'swarm-pr-review:base',
					workflowLane: batchLane.workflowLane,
					...(batchLane.ownedWorkflowLanes
						? { ownedWorkflowLanes: batchLane.ownedWorkflowLanes }
						: { ownedWorkflowLanes: undefined }),
					result: terminalResult,
					completedAt: timestamp,
					terminalResult: {
						eventId: `event-${batchIndex}-${laneIndex}`,
						status: 'error' as const,
						recordedAt: timestamp,
						result: terminalResult,
					},
				};
			}),
		);
		expect(seededRecords).toHaveLength(132);

		await writeWorkflowGateState(sessionID, (current) => ({
			...current,
			updatedAt: '2026-08-23T01:00:00.000Z',
			prReviewBaseDispatches: seededBatches,
			prReviewBaseDispatch: seededBatches.at(-1),
			// A persisted UNVERSIONED (pre-#2382) circuit: blocked forever under
			// the old shape; must migrate once to a nonblocking v2 CLOSED record.
			prReviewResilience: {
				policy: {
					enabled: true,
					canaryProbeMs: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.canary_probe_ms,
					statusProbeTimeoutMs:
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.status_probe_timeout_ms,
					correlatedFailureThreshold:
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.correlated_failure_threshold,
					maxRetryAttemptsAfterInitial:
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.max_retry_attempts_after_initial,
				},
				attempts: [],
				circuit: {
					signature: 'terminal-error-output:error:http 503 upstream overloaded',
					count: 6,
					contributors: seededBatches.slice(0, 6).map((batch, index) => ({
						batchId: batch.batchId,
						laneId: batch.lanes[index]!.laneId,
					})),
					openedAt: '2026-08-23T00:30:00.000Z',
				},
			},
		}));
		await clearDelegationCheckpointArtifacts(directory);
		await fs.writeFile(
			path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${seededRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
			'utf-8',
		);
		gateInternals.resetTrackedStateCache();
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const admitted = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane('circuit-migration-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!),
				],
			},
			directory,
			{ sessionID },
		);
		expect(admitted.success).toBe(true);

		const state = await readPrWorkflowGateState(directory, sessionID);
		const circuit = state?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('CLOSED');
		expect(circuit?.contributors).toHaveLength(0);
		expect(circuit?.evidenceWaterline).toBeDefined();
		expect(state?.prReviewResilience?.attempts).toHaveLength(1);
		expect(created).toBe(7);

		await removeDelegationStore(directory);
		gateInternals.resetTrackedStateCache();
		const reloaded = await readPrWorkflowGateState(directory, sessionID);
		const reloadedCircuit = reloaded?.prReviewResilience?.circuit;
		expect(reloadedCircuit?.version).toBe(2);
		expect(reloadedCircuit?.state).toBe('CLOSED');
		expect(reloadedCircuit?.evidenceWaterline).toBeDefined();

		// The canary admission above IS the no-immediate-reopen proof: the
		// machine evaluated the full legacy evidence set (132 records, none
		// typed) against the migrated CLOSED record and did not open. The
		// migration is durable across a state reload, as asserted above.
	});

	test('reloads a persisted circuit at the exact contributor bound', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'review-session-circuit-boundary';
		const wave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('legacy-boundary'),
			},
			directory,
			{ sessionID },
		);
		expect(wave.success).toBe(true);

		const maxContributors =
			gateInternals.MAX_PR_REVIEW_RESILIENCE_CIRCUIT_CONTRIBUTORS;
		expect(maxContributors).toBe(
			gateInternals.MAX_WORKFLOW_BATCHES * PR_REVIEW_BASE_DIMENSION_IDS.length,
		);

		await writeWorkflowGateState(sessionID, (current) => ({
			...current,
			prReviewResilience: {
				policy: {
					enabled: true,
					canaryProbeMs: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.canary_probe_ms,
					statusProbeTimeoutMs:
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.status_probe_timeout_ms,
					correlatedFailureThreshold:
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.correlated_failure_threshold,
					maxRetryAttemptsAfterInitial:
						DEFAULT_PR_REVIEW_RESILIENCE_CONFIG.max_retry_attempts_after_initial,
				},
				attempts: [],
				circuit: {
					version: 2,
					state: 'OPEN',
					generation: 1,
					providerClass: 'provider.rate_limit',
					contributors: Array.from({ length: maxContributors }, (_, index) => ({
						batchId: `batch-${Math.floor(index / PR_REVIEW_BASE_DIMENSION_IDS.length)}`,
						laneId: `lane-${index}`,
						terminalAt: '2026-08-23T00:00:00.000Z',
					})),
					openedAt: '2026-08-23T00:00:00.000Z',
					openUntil: '2026-08-23T00:01:00.000Z',
				},
			},
		}));

		const reloaded = await readPrWorkflowGateState(directory, sessionID);
		const circuit = reloaded?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		expect(circuit?.contributors).toHaveLength(maxContributors);
	});
});
