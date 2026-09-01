import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
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

const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const REVISION_DIGEST = 'revision-1';
const BASE_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;

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

async function appendSuccessfulBaseTransition(
	sessionID: string,
	record: NonNullable<ReturnType<typeof findByBatchId>[number]>,
) {
	const text = [
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence | risk_impact | risk_tags',
		`${record.laneId}-candidate | ${record.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH | ORDINARY | `,
	].join('\n');
	const stored = storeLaneOutput(directory, {
		batchId: record.batchId,
		laneId: record.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: record.subagentSessionId,
		parentSessionId: sessionID,
		mode: 'swarm-pr-review:base',
		workflowLane: record.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: BASE_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, record.correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
		expectedCurrentStatuses: ['pending', 'running'],
	});
}

async function removePersistedResilienceSnapshot(sessionID: string) {
	const statePath = path.join(
		directory,
		'.swarm',
		gateInternals.workflowGateStateRelativePath(sessionID),
	);
	const persisted = JSON.parse(await fs.readFile(statePath, 'utf-8')) as Record<
		string,
		unknown
	>;
	delete persisted.prReviewResilience;
	await fs.writeFile(statePath, JSON.stringify(persisted, null, 2), 'utf-8');
	gateInternals.resetTrackedStateCache();
}

async function dispatchLegacyFullWave(
	sessionID: string,
	prefix: string,
): Promise<string> {
	const legacyWave = await executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:base',
			pr_head_sha: HEAD_SHA,
			base_sha: BASE_SHA,
			base_ref: 'origin/main',
			max_concurrent: 6,
			lanes: fullWave(prefix),
		},
		directory,
		{ sessionID },
	);
	expect(legacyWave.success).toBe(true);
	return String(legacyWave.batch_id);
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-upgrade-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
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
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => BASE_SHA;
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
	dispatchInternals.loadPluginConfig = () =>
		({
			pr_review_legacy_transcript_compatibility: true,
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
	await fs.rm(directory, { recursive: true, force: true });
});

describe('dispatch_lanes PR review resilience upgrade migration', () => {
	test('migrates legacy pre-resilience state to staged admission using only unresolved non-live obligations', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'review-session-upgrade-mixed';
		const legacyBatchId = await dispatchLegacyFullWave(
			sessionID,
			'legacy-upgrade',
		);
		for (const record of findByBatchId(directory, legacyBatchId, {
			parentSessionId: sessionID,
		})) {
			if (
				record.laneId === 'legacy-upgrade-0' ||
				record.laneId === 'legacy-upgrade-4'
			) {
				await appendSuccessfulBaseTransition(sessionID, record);
				continue;
			}
			if (record.laneId !== 'legacy-upgrade-1') {
				await appendDelegationTransition(directory, record.correlationId, {
					status: 'error',
					result: terminalErrorResult(`legacy failure ${record.laneId}`),
					expectedCurrentStatuses: ['pending', 'running'],
				});
			}
		}

		await removePersistedResilienceSnapshot(sessionID);
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_legacy_transcript_compatibility: true,
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const migratedCanary = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [lane('upgrade-canary-0', PR_REVIEW_BASE_DIMENSION_IDS[2]!)],
			},
			directory,
			{ sessionID },
		);
		expect(migratedCanary.success).toBe(true);
		expect(created).toBe(7);

		const migratedState = await readPrWorkflowGateState(directory, sessionID);
		expect(migratedState?.prReviewResilience?.policy.enabled).toBe(true);
		expect(
			migratedState?.prReviewResilience?.attempts[0]?.targetDimensions,
		).toEqual([
			PR_REVIEW_BASE_DIMENSION_IDS[2],
			PR_REVIEW_BASE_DIMENSION_IDS[3],
			PR_REVIEW_BASE_DIMENSION_IDS[5],
		]);

		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_legacy_transcript_compatibility: true,
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
		const migratedRecord = findByBatchId(
			directory,
			String(migratedCanary.batch_id),
			{ parentSessionId: sessionID },
		)[0];
		await appendDelegationTransition(directory, migratedRecord!.correlationId, {
			status: 'error',
			result: terminalErrorResult(
				'migrated canary failed under persisted policy',
			),
			expectedCurrentStatuses: ['pending', 'running'],
		});

		// Issue #2382: the CURRENT config's enabled flag is authoritative. A
		// staged retry under a disabled config is invalid — the persisted
		// enabled snapshot no longer keeps resilience semantics alive — and the
		// enforcement's guarded audit write marks the persisted policy disabled
		// (record kept for audit, attempt ledger untouched).
		const persistedRetry = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 1,
				max_concurrent: 1,
				lanes: [lane('upgrade-canary-1', PR_REVIEW_BASE_DIMENSION_IDS[3]!)],
			},
			directory,
			{ sessionID },
		);
		expect(persistedRetry.success).toBe(false);
		expect(persistedRetry.failure_class).toBe('invalid_args');
		expect(String(persistedRetry.message)).toContain(
			'staged PR_REVIEW base dispatch is valid only when pr_review_resilience is enabled',
		);
		// (The audit write that marks the persisted policy disabled is exercised
		// by the follow-ups suite's legacy-wave disable test; the staged path is
		// rejected at the dispatch layer before any gate enforcement runs.)
		expect(created).toBe(7);
	});

	test('migrated legacy state fails closed when every obligation is already successful', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'review-session-upgrade-exhausted';
		const legacyBatchId = await dispatchLegacyFullWave(
			sessionID,
			'legacy-exhausted',
		);
		for (const record of findByBatchId(directory, legacyBatchId, {
			parentSessionId: sessionID,
		})) {
			await appendSuccessfulBaseTransition(sessionID, record);
		}

		await removePersistedResilienceSnapshot(sessionID);
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_legacy_transcript_compatibility: true,
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const blocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane('upgrade-exhausted-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!),
				],
			},
			directory,
			{ sessionID },
		);
		expect(blocked.success).toBe(false);
		expect(String(blocked.message)).toContain(
			'no unresolved obligations remaining',
		);
		expect(created).toBe(6);

		const migratedState = await readPrWorkflowGateState(directory, sessionID);
		expect(migratedState?.prReviewResilience?.policy.enabled).toBe(true);
		expect(migratedState?.prReviewResilience?.attempts).toEqual([]);
	});

	test('migrated legacy state fails closed when only in-flight obligations remain', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'review-session-upgrade-inflight';
		const legacyBatchId = await dispatchLegacyFullWave(
			sessionID,
			'legacy-inflight',
		);
		for (const record of findByBatchId(directory, legacyBatchId, {
			parentSessionId: sessionID,
		})) {
			if (record.laneId === 'legacy-inflight-1') continue;
			await appendSuccessfulBaseTransition(sessionID, record);
		}

		await removePersistedResilienceSnapshot(sessionID);
		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_legacy_transcript_compatibility: true,
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;

		const blocked = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane('upgrade-inflight-canary', PR_REVIEW_BASE_DIMENSION_IDS[0]!),
				],
			},
			directory,
			{ sessionID },
		);
		expect(blocked.success).toBe(false);
		expect(String(blocked.message)).toContain(
			'still has in-flight obligations that cannot be retried yet',
		);
		expect(created).toBe(6);

		const migratedState = await readPrWorkflowGateState(directory, sessionID);
		expect(migratedState?.prReviewResilience?.policy.enabled).toBe(true);
		expect(migratedState?.prReviewResilience?.attempts).toEqual([]);
	});
});
