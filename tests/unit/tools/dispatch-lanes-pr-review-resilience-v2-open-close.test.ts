/**
 * Issue #2382 — behavior tests for the v2 circuit through the real gate
 * enforcement path: the REQUIRED consolidated-lane regression (one lane owning
 * all six dimensions contributes ONE sample), the two-distinct-lane opening,
 * and recovery-tool reachability while the circuit is OPEN.
 */
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
	abortPrWorkflow,
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

function laneSpec(id: string, workflowLane: string, owned?: string[]) {
	return {
		laneId: id,
		workflowLane,
		...(owned ? { ownedWorkflowLanes: owned } : {}),
	};
}

function consolidatedSix(id: string) {
	return laneSpec(id, PR_REVIEW_BASE_DIMENSION_IDS[0]!, [
		...PR_REVIEW_BASE_DIMENSION_IDS,
	]);
}

function providerResult() {
	return {
		error: 'HTTP 503 upstream overloaded',
		text: '[ERROR] HTTP 503 upstream overloaded',
		chars: 40,
		truncated: false,
		digest: 'digest-503',
		// Issue #2382: exactly what the settle path persists for a provider
		// termination.
		terminalErrorClass: {
			kind: 'provider' as const,
			category: 'provider.rate_limit',
			statusCode: 503,
			hostRetryable: true,
		},
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

function providerRecord(args: {
	sessionID: string;
	batchId: string;
	laneId: string;
	timestamp: number;
}) {
	const correlationId = `v2oc-corr-${args.batchId}-${args.laneId}`;
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

function baseGateState(
	sessionID: string,
	batches: Array<Record<string, unknown>>,
) {
	return {
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
		prReviewBaseDispatches: batches,
		prReviewBaseDispatch: batches.at(-1),
	};
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-v2oc-');
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

describe('dispatch_lanes PR review resilience v2 open/close (issue #2382)', () => {
	test('REQUIRED regression: one consolidated provider-failed lane owning all six dimensions contributes one sample and cannot open the circuit', async () => {
		const sessionID = 'v2oc-consolidated';
		const batch1 = {
			batchId: 'v2oc-batch-1',
			lanes: [consolidatedSix('v2oc-lane-1')],
			validatedAt: '2026-08-23T01:30:00.000Z',
		};
		await writeWorkflowGateState(sessionID, baseGateState(sessionID, [batch1]));
		await seedRecords(sessionID, [
			providerRecord({
				sessionID,
				batchId: batch1.batchId,
				laneId: 'v2oc-lane-1',
				timestamp: 5_000,
			}),
		]);

		// Under the pre-#2382 dimension counting this dispatch was BLOCKED (six
		// owned dimensions >= threshold 2 from ONE lane). Distinct-lane counting
		// admits it: one lane is one sample.
		const state = await enforcePrReviewBaseDimensions(
			directory,
			sessionID,
			[laneSpec('v2oc-canary-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
			{
				batchId: 'v2oc-attempt-0',
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
		expect(state.prReviewResilience?.attempts).toHaveLength(1);
		expect(state.prReviewResilience?.circuit).toBeUndefined();
	});

	test('two distinct terminal provider-failed lanes of the same provider class open a versioned OPEN circuit; recovery tools stay reachable', async () => {
		const sessionID = 'v2oc-open';
		const batch1 = {
			batchId: 'v2oc-batch-1',
			lanes: [consolidatedSix('v2oc-lane-1')],
			validatedAt: '2026-08-23T01:30:00.000Z',
		};
		const batch2 = {
			batchId: 'v2oc-batch-2',
			lanes: [consolidatedSix('v2oc-lane-2')],
			validatedAt: '2026-08-23T01:31:00.000Z',
		};
		await writeWorkflowGateState(
			sessionID,
			baseGateState(sessionID, [batch1, batch2]),
		);
		await seedRecords(sessionID, [
			providerRecord({
				sessionID,
				batchId: batch1.batchId,
				laneId: 'v2oc-lane-1',
				timestamp: 5_000,
			}),
			providerRecord({
				sessionID,
				batchId: batch2.batchId,
				laneId: 'v2oc-lane-2',
				timestamp: 6_000,
			}),
		]);

		let blockedError: unknown = null;
		try {
			await enforcePrReviewBaseDimensions(
				directory,
				sessionID,
				[laneSpec('v2oc-canary-0', PR_REVIEW_BASE_DIMENSION_IDS[0]!)],
				{
					batchId: 'v2oc-attempt-0',
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
		} catch (error) {
			blockedError = error;
		}
		expect(blockedError).toBeInstanceOf(PrReviewResilienceCircuitOpenError);

		const state = await readPrWorkflowGateState(directory, sessionID);
		expect(state).toBeDefined();
		const circuit = state?.prReviewResilience?.circuit;
		expect(circuit?.version).toBe(2);
		expect(circuit?.state).toBe('OPEN');
		expect(circuit?.providerClass).toBe('provider.rate_limit');
		expect(circuit?.contributors).toHaveLength(2);
		const contributorKeys = new Set(
			(circuit?.contributors ?? []).map(
				(entry: { batchId: string; laneId: string }) =>
					`${entry.batchId}\u0000${entry.laneId}`,
			),
		);
		expect(contributorKeys.size).toBe(2);

		// While OPEN, the recovery tool stays reachable: abort (recovery) works
		// and clears the gate state, exactly the diagnostic/abort reachability
		// the issue requires.
		const aborted = await abortPrWorkflow(directory, sessionID, {
			kind: 'force',
			reason: 'v2 open-close test: abort while circuit OPEN',
		});
		expect(aborted.mode).toBe('PR_REVIEW');
		const afterAbort = await readPrWorkflowGateState(directory, sessionID);
		expect(afterAbort).toBeNull();
	});
});
