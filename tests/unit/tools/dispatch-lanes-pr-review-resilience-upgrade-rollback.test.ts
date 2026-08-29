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
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
		`${record.laneId}-candidate | ${record.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH`,
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

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-upgrade-rollback-');
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

describe('dispatch_lanes PR review resilience upgrade rollback', () => {
	test('migrated policy survives zero-record staged rollback and re-admits the same unresolved-only attempt 0 target', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'review-session-upgrade-rollback';
		const legacyWave = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('legacy-rollback'),
			},
			directory,
			{ sessionID },
		);
		expect(legacyWave.success).toBe(true);
		const legacyBatchId = String(legacyWave.batch_id);
		for (const record of findByBatchId(directory, legacyBatchId, {
			parentSessionId: sessionID,
		})) {
			if (
				record.laneId === 'legacy-rollback-0' ||
				record.laneId === 'legacy-rollback-4'
			) {
				await appendSuccessfulBaseTransition(sessionID, record);
				continue;
			}
			if (record.laneId !== 'legacy-rollback-1') {
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
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: true,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
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
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane(
						'upgrade-rollback-canary-failed',
						PR_REVIEW_BASE_DIMENSION_IDS[2]!,
					),
				],
			},
			directory,
			{ sessionID },
		);
		expect(failed.success).toBe(false);
		expect(
			findByBatchId(directory, String(failed.batch_id), {
				parentSessionId: sessionID,
			}),
		).toHaveLength(0);

		const rolledBackState = await readPrWorkflowGateState(directory, sessionID);
		expect(rolledBackState?.prReviewBaseDispatches).toHaveLength(1);
		expect(rolledBackState?.prReviewBaseDispatch?.batchId).toBe(legacyBatchId);
		expect(rolledBackState?.prReviewResilience?.policy.enabled).toBe(true);
		expect(rolledBackState?.prReviewResilience?.attempts).toEqual([]);

		dispatchInternals.loadPluginConfig = () =>
			({
				pr_review_resilience: {
					...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
					enabled: false,
				},
			}) as ReturnType<typeof originalDispatchLoadPluginConfig>;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		// Issue #2382: the CURRENT config's enabled flag is authoritative. A
		// staged canary retry under a disabled config is invalid (the persisted
		// enabled snapshot no longer keeps staged admission alive), and the
		// enforcement's guarded audit write marks the persisted policy disabled
		// while preserving the record for audit.
		const retried = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_wave_stage: 'canary',
				pr_review_wave_attempt: 0,
				max_concurrent: 1,
				lanes: [
					lane(
						'upgrade-rollback-canary-retried',
						PR_REVIEW_BASE_DIMENSION_IDS[3]!,
					),
				],
			},
			directory,
			{ sessionID },
		);
		expect(retried.success).toBe(false);
		expect(retried.failure_class).toBe('invalid_args');
		expect(String(retried.message)).toContain(
			'staged PR_REVIEW base dispatch is valid only when pr_review_resilience is enabled',
		);
		expect(created).toBe(7);

		// The rejection happens at the dispatch layer, before any gate
		// enforcement — the record is unchanged (still enabled, empty attempts).
		const unchangedState = await readPrWorkflowGateState(directory, sessionID);
		expect(unchangedState?.prReviewResilience?.policy.enabled).toBe(true);
		expect(unchangedState?.prReviewResilience?.attempts).toEqual([]);
	});

	test('contract retry admission rolls back when launch fails without staged markers', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const sessionID = 'contract-retry-rollback';
		const initial = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: fullWave('contract-seed'),
			},
			directory,
			{ sessionID },
		);
		expect(initial.success).toBe(true);
		const initialRecords = findByBatchId(directory, String(initial.batch_id), {
			parentSessionId: sessionID,
		});
		expect(initialRecords).toHaveLength(PR_REVIEW_BASE_DIMENSION_IDS.length);
		for (const record of initialRecords) {
			if (record.workflowLane === PR_REVIEW_BASE_DIMENSION_IDS[5]) {
				await appendDelegationTransition(directory, record.correlationId, {
					status: 'error',
					result: {
						...terminalErrorResult(`contract failure ${record.laneId}`),
						workflowLaneFailureClass: 'contract',
					},
					expectedCurrentStatuses: ['pending', 'running'],
				});
				continue;
			}
			await appendSuccessfulBaseTransition(sessionID, record);
		}

		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ error: 'upstream create unavailable' })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const failed = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: HEAD_SHA,
				base_sha: BASE_SHA,
				base_ref: 'origin/main',
				pr_review_contract_retry: true,
				max_concurrent: 1,
				lanes: [
					lane('contract-retry-unlaunched', PR_REVIEW_BASE_DIMENSION_IDS[5]!),
				],
			},
			directory,
			{ sessionID },
		);
		expect(failed.success).toBe(false);
		const state = await readPrWorkflowGateState(directory, sessionID);
		expect(state?.prReviewContractRetryDimensions).toBeUndefined();
		expect(
			findByBatchId(directory, String(failed.batch_id), {
				parentSessionId: sessionID,
			}),
		).toHaveLength(0);
	});
});
