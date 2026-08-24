import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
} from '../../../src/background/pending-delegations.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import {
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PrReviewResilienceCircuitOpenError,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

let directory = '';
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
		laneId: id,
		workflowLane,
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

async function writeWorkflowGateState(
	sessionID: string,
	state: Record<string, unknown>,
) {
	const statePath = path.join(
		directory,
		'.swarm',
		gateInternals.workflowGateStateRelativePath(sessionID),
	);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
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
	directory = canonicalMkdtemp('dispatch-pr-resilience-circuit-prune-');
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
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
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

describe('dispatch_lanes PR review resilience circuit prune ordering', () => {
	test('pre-prune staged migration preserves an older open circuit at exactly 128 legacy batches', async () => {
		const sessionID = 'review-session-circuit-prune';
		const maxBatches = gateInternals.MAX_WORKFLOW_BATCHES;
		const seededBatches = Array.from(
			{ length: maxBatches },
			(_, batchIndex) => ({
				batchId: `legacy-prune-batch-${batchIndex}`,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((dimension, laneIndex) => ({
					laneId: `legacy-prune-lane-${batchIndex}-${laneIndex}`,
					workflowLane: dimension,
				})),
				validatedAt: `2026-08-23T00:${String(batchIndex % 60).padStart(2, '0')}:${String(batchIndex % 60).padStart(2, '0')}.000Z`,
			}),
		);
		const correlated = terminalErrorResult('HTTP 503 upstream overloaded');
		const recordedBatchIndexes = new Set([0, 1, maxBatches - 1]);
		const seededRecords = seededBatches.flatMap((batch, batchIndex) => {
			if (!recordedBatchIndexes.has(batchIndex)) return [];
			return batch.lanes.map((batchLane, laneIndex) => {
				const timestamp = 5_000 + batchIndex * 10 + laneIndex;
				const correlationId = `legacy-prune-corr-${batchIndex}-${laneIndex}`;
				const result =
					batchIndex < 2
						? correlated
						: terminalErrorResult(
								`HTTP ${500 + batchIndex}-${laneIndex} distinct newest failure`,
							);
				return {
					schemaVersion: 2 as const,
					correlationId,
					jobId: null,
					subagentSessionId: correlationId,
					parentSessionId: sessionID,
					callID: `call-${batchIndex}-${laneIndex}`,
					normalizedAgent: 'explorer',
					swarmPrefixedAgent: 'explorer',
					planTaskId: null,
					evidenceTaskId: null,
					status: 'error' as const,
					createdAt: timestamp,
					updatedAt: timestamp,
					batchId: batch.batchId,
					laneId: batchLane.laneId,
					mode: 'swarm-pr-review:base',
					workflowLane: batchLane.workflowLane,
					result,
					completedAt: timestamp,
					terminalResult: {
						eventId: `event-${batchIndex}-${laneIndex}`,
						status: 'error' as const,
						recordedAt: timestamp,
						result,
					},
				};
			});
		});
		expect(seededBatches).toHaveLength(maxBatches);

		await writeWorkflowGateState(sessionID, {
			schemaVersion: 1,
			revision: 0,
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
			prReviewBaseDispatches: seededBatches,
			prReviewBaseDispatch: seededBatches.at(-1),
			prReviewResilience: undefined,
		});
		await clearDelegationCheckpointArtifacts(directory);
		await fs.mkdir(path.join(directory, '.swarm'), { recursive: true });
		await fs.writeFile(
			path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE),
			`${seededRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
			'utf-8',
		);
		gateInternals.resetTrackedStateCache();
		let blockedError: unknown = null;
		try {
			await enforcePrReviewBaseDimensions(
				directory,
				sessionID,
				[lane('circuit-prune-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
				{
					batchId: 'circuit-prune-attempt-0',
					prHeadSha: 'abc123',
					prReviewWaveStage: 'canary',
					prReviewWaveAttempt: 0,
					prReviewResiliencePolicy: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
				},
			);
		} catch (error) {
			blockedError = error;
		}
		expect(blockedError).toBeInstanceOf(PrReviewResilienceCircuitOpenError);

		const state = await readPrWorkflowGateState(directory, sessionID);
		expect(state?.prReviewBaseDispatches).toHaveLength(maxBatches);
		expect(state?.prReviewResilience?.circuit?.count).toBe(
			PR_REVIEW_BASE_DIMENSION_IDS.length,
		);
		expect(state?.prReviewResilience?.circuit?.contributors).toHaveLength(
			PR_REVIEW_BASE_DIMENSION_IDS.length,
		);

		await removeDelegationStore(directory);
		gateInternals.resetTrackedStateCache();
		const reloaded = await readPrWorkflowGateState(directory, sessionID);
		expect(reloaded?.prReviewResilience?.circuit?.count).toBe(
			PR_REVIEW_BASE_DIMENSION_IDS.length,
		);

		await expect(
			enforcePrReviewBaseDimensions(
				directory,
				sessionID,
				[lane('circuit-prune-canary-retry', PR_REVIEW_BASE_DIMENSION_IDS[1]!)],
				{
					batchId: 'circuit-prune-attempt-0-retry',
					prHeadSha: 'abc123',
					prReviewWaveStage: 'canary',
					prReviewWaveAttempt: 0,
					prReviewResiliencePolicy: DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
				},
			),
		).rejects.toBeInstanceOf(PrReviewResilienceCircuitOpenError);
	});
});
