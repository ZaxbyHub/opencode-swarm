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

/**
 * Issue #2385 replay corpus — historical failure shape 3 from tracker #2380:
 * the consolidated-lane circuit-opening shape (PR #2329 incident R4). One
 * tier-M lane owning two (or all six) dimensions timed out at a caller-chosen
 * join budget; the pre-#2382 dimension-cardinality accounting opened the
 * resilience circuit DURABLY from that single lane and attempt-2 dispatch was
 * refused with `failure_class: circuit_open`.
 *
 * Replayed through the registered enforcement path the dispatch tool calls
 * (`enforcePrReviewBaseDimensions`, reached from executeDispatchLanesAsync):
 * one lane is ONE sample regardless of owned dimensions; only distinct
 * terminal provider-failed lanes of one provider class can open the circuit.
 */

let directory = '';
const originalGateGetSessionOps = gateInternals.getSessionOps;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean = gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync = gateInternals.resolvePrReviewDiffStatsAsync;

function providerResult() {
	return {
		error: 'HTTP 503 upstream overloaded',
		text: '[ERROR] HTTP 503 upstream overloaded',
		chars: 40,
		truncated: false,
		digest: 'digest-503',
		terminalErrorClass: {
			kind: 'provider' as const,
			category: 'provider.rate_limit',
			statusCode: 503,
			hostRetryable: true,
		},
	};
}

function providerRecord(args: {
	sessionID: string;
	batchId: string;
	laneId: string;
	timestamp: number;
}) {
	const correlationId = `corpus-corr-${args.batchId}-${args.laneId}`;
	const result = providerResult();
	return {
		schemaVersion: 2 as const,
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: args.sessionID,
		callID: `call-${args.batchId}-${args.laneId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'error' as const,
		createdAt: args.timestamp,
		updatedAt: args.timestamp,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0],
		result,
		completedAt: args.timestamp,
		terminalResult: {
			eventId: `event-${args.batchId}-${args.laneId}`,
			status: 'error' as const,
			recordedAt: args.timestamp,
			result,
		},
	};
}

function consolidatedSix(batchId: string, laneId: string) {
	return {
		batchId,
		lanes: [
			{
				laneId,
				workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0]!,
				ownedWorkflowLanes: [...PR_REVIEW_BASE_DIMENSION_IDS],
			},
		],
		validatedAt: '2026-08-26T01:30:00.000Z',
	};
}

function baseGateState(
	sessionID: string,
	batches: Array<Record<string, unknown>>,
) {
	return {
		schemaVersion: 1,
		revision: 0,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-08-26T01:00:00.000Z',
		updatedAt: '2026-08-26T02:00:00.000Z',
		prHeadSha: 'abc123',
		prReviewBaseRef: 'origin/main',
		prReviewBaseSha: 'def456',
		prReviewDepthTier: 'M',
		prReviewDiffStats: {
			changedLines: 2_000,
			changedFiles: 60,
			hasSubmoduleChange: false,
		},
		prReviewBaseDispatches: batches,
		prReviewBaseDispatch: batches.at(-1),
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

async function seedRecords(
	sessionID: string,
	records: Array<Record<string, unknown>>,
) {
	for (const filename of [
		BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
		BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	]) {
		await fs.rm(path.join(directory, '.swarm', filename), { force: true });
	}
	await fs.mkdir(path.join(directory, '.swarm'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.swarm', BACKGROUND_DELEGATIONS_FILE),
		`${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
		'utf-8',
	);
	gateInternals.resetTrackedStateCache();
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-review-corpus-circuit-');
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
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	gateInternals.getSessionOps = () => null;
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
	await fs.rm(directory, { recursive: true, force: true });
});

async function attemptStagedCanary(sessionID: string, batchId: string) {
	return enforcePrReviewBaseDimensions(
		directory,
		sessionID,
		[{ laneId: `${batchId}-canary`, workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[0]! }],
		{
			batchId,
			revisionDigest: 'revision-1',
			prHeadSha: 'abc123',
			prReviewWaveStage: 'canary',
			prReviewWaveAttempt: 0,
			prReviewResiliencePolicy: {
				...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
				enabled: true,
			},
		},
	);
}

describe('replay corpus: consolidated-lane circuit shape (#2380 shape 3)', () => {
	test('one provider-failed lane owning ALL SIX dimensions cannot open the circuit', async () => {
		const sessionID = 'corpus-circuit-single';
		await writeWorkflowGateState(sessionID, baseGateState(sessionID, [
			consolidatedSix('corpus-batch-1', 'corpus-lane-1'),
		]));
		await seedRecords(sessionID, [
			providerRecord({
				sessionID,
				batchId: 'corpus-batch-1',
				laneId: 'corpus-lane-1',
				timestamp: 5_000,
			}),
		]);

		const state = await attemptStagedCanary(sessionID, 'corpus-attempt-0');
		expect(state.prReviewResilience?.attempts).toHaveLength(1);
		// One lane = one sample: the circuit stays CLOSED (threshold 2).
		expect(state.prReviewResilience?.circuit).toBeUndefined();
	});

	test('two DISTINCT provider-failed lanes open the circuit; diagnostics remain reachable', async () => {
		const sessionID = 'corpus-circuit-open';
		await writeWorkflowGateState(sessionID, baseGateState(sessionID, [
			consolidatedSix('corpus-batch-1', 'corpus-lane-1'),
			consolidatedSix('corpus-batch-2', 'corpus-lane-2'),
		]));
		await seedRecords(sessionID, [
			providerRecord({
				sessionID,
				batchId: 'corpus-batch-1',
				laneId: 'corpus-lane-1',
				timestamp: 5_000,
			}),
			providerRecord({
				sessionID,
				batchId: 'corpus-batch-2',
				laneId: 'corpus-lane-2',
				timestamp: 6_000,
			}),
		]);

		let blocked: unknown = null;
		try {
			await attemptStagedCanary(sessionID, 'corpus-attempt-0');
		} catch (error) {
			blocked = error;
		}
		expect(blocked).toBeInstanceOf(PrReviewResilienceCircuitOpenError);

		const state = await readPrWorkflowGateState(directory, sessionID);
		const circuit = state?.prReviewResilience?.circuit as
			| { version?: number; state?: string; contributors?: unknown[] }
			| undefined;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		// Distinct-lane counting: exactly two contributors, not twelve.
		expect(circuit?.contributors).toHaveLength(2);
	});
});
