import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	findByBatchId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { DEFAULT_PR_REVIEW_RESILIENCE_CONFIG } from '../../../src/config/schema.js';
import {
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
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
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalGateResolveRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync =
	gateInternals.resolvePrReviewDiffStatsAsync;

const HEAD_SHA = 'abc123';
const BASE_SHA = 'def456';
const REVISION_DIGEST = 'revision-1';
const BASE_SCOPE = `complete PR diff ${BASE_SHA}...${HEAD_SHA}`;
const RESILIENCE_POLICY = {
	...DEFAULT_PR_REVIEW_RESILIENCE_CONFIG,
	enabled: true,
};
const [DIM_A, DIM_B, DIM_C, DIM_D, DIM_E, DIM_F] = PR_REVIEW_BASE_DIMENSION_IDS;

function lane(id: string, workflowLane: string, ownedWorkflowLanes?: string[]) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: workflowLane,
		...(ownedWorkflowLanes ? { owned_workflow_lanes: ownedWorkflowLanes } : {}),
	};
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

async function persistAuthoritativeBaseLane(args: {
	sessionID: string;
	batchId: string;
	laneId: string;
	workflowLane: string;
	ownedWorkflowLanes?: string[];
	candidateId: string;
}) {
	const correlationId = `${args.batchId}--${args.laneId}`;
	const text = [
		'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence',
		`${args.candidateId} | ${args.workflowLane} | HIGH | correctness | file.ts:1 | claim | evidence | impact | HIGH`,
	].join('\n');
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: args.sessionID,
		callID: `call-${correlationId}`,
		normalizedAgent: 'explorer',
		swarmPrefixedAgent: 'explorer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: args.batchId,
		laneId: args.laneId,
		mode: 'swarm-pr-review:base',
		workflowLane: args.workflowLane,
		ownedWorkflowLanes: args.ownedWorkflowLanes,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: BASE_SCOPE,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: args.batchId,
		laneId: args.laneId,
		agent: 'explorer',
		role: 'explorer',
		sessionId: correlationId,
		parentSessionId: args.sessionID,
		mode: 'swarm-pr-review:base',
		workflowLane: args.workflowLane,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION_DIGEST,
		scope: BASE_SCOPE,
		source: 'collect_lane_results',
		text,
	});
	await appendDelegationTransition(directory, correlationId, {
		status: 'completed',
		result: {
			text,
			chars: stored.chars,
			truncated: false,
			digest: stored.digest,
			outputRef: stored.ref,
		},
		expectedCurrentStatuses: ['pending'],
	});
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-resilience-singleton-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 400,
		changedFiles: 12,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => BASE_SHA;
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
	dispatchInternals.loadPluginConfig = () =>
		({
			pr_review_resilience: RESILIENCE_POLICY,
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
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalGateResolveRevisionDigest;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('dispatch_lanes PR review resilience singleton and concurrency', () => {
	test('a singleton retry canary settles the last unresolved base dimension without requiring an empty fanout', async () => {
		const sessionID = 'review-session-singleton';
		await activatePrWorkflow(directory, sessionID, 'PR_REVIEW');
		await bindPrReviewBase(directory, sessionID, {
			prHeadSha: HEAD_SHA,
			baseRef: 'origin/main',
			baseSha: BASE_SHA,
		});

		await enforcePrReviewBaseDimensions(
			directory,
			sessionID,
			[{ laneId: 'canary-0', workflowLane: DIM_A }],
			{
				batchId: 'canary-attempt-0',
				prHeadSha: HEAD_SHA,
				prReviewWaveStage: 'canary',
				prReviewWaveAttempt: 0,
				prReviewResiliencePolicy: RESILIENCE_POLICY,
			},
		);
		await persistAuthoritativeBaseLane({
			sessionID,
			batchId: 'canary-attempt-0',
			laneId: 'canary-0',
			workflowLane: DIM_A,
			candidateId: 'INITIAL-CANARY-A',
		});

		const fanoutLanes = [DIM_B, DIM_C, DIM_D, DIM_E, DIM_F].map(
			(workflowLane) => ({
				laneId: `fanout-${workflowLane}`,
				workflowLane,
			}),
		);
		await enforcePrReviewBaseDimensions(directory, sessionID, fanoutLanes, {
			batchId: 'fanout-attempt-0',
			prHeadSha: HEAD_SHA,
			prReviewWaveStage: 'fanout',
			prReviewWaveAttempt: 0,
			prReviewResiliencePolicy: RESILIENCE_POLICY,
		});
		for (const [index, successful] of fanoutLanes.slice(0, -1).entries()) {
			await persistAuthoritativeBaseLane({
				sessionID,
				batchId: 'fanout-attempt-0',
				laneId: successful.laneId,
				workflowLane: successful.workflowLane,
				candidateId: `FANOUT-SUCCESS-${index}`,
			});
		}
		await recordPendingDelegation(directory, {
			correlationId: 'fanout-attempt-0--failed-f',
			jobId: null,
			subagentSessionId: 'fanout-attempt-0--failed-f',
			parentSessionId: sessionID,
			callID: 'call-fanout-attempt-0--failed-f',
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'fanout-attempt-0',
			laneId: `fanout-${DIM_F}`,
			mode: 'swarm-pr-review:base',
			workflowLane: DIM_F,
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: BASE_SCOPE,
			},
		});
		await appendDelegationTransition(directory, 'fanout-attempt-0--failed-f', {
			status: 'error',
			result: terminalErrorResult('HTTP 503 prior fanout lane failed'),
			expectedCurrentStatuses: ['pending'],
		});

		const retryState = await enforcePrReviewBaseDimensions(
			directory,
			sessionID,
			[{ laneId: 'canary-1', workflowLane: DIM_F }],
			{
				batchId: 'canary-attempt-1',
				prHeadSha: HEAD_SHA,
				prReviewWaveStage: 'canary',
				prReviewWaveAttempt: 1,
				prReviewResiliencePolicy: RESILIENCE_POLICY,
			},
		);
		expect(
			retryState.prReviewResilience?.attempts.at(-1)?.targetDimensions,
		).toEqual([DIM_F]);
		await persistAuthoritativeBaseLane({
			sessionID,
			batchId: 'canary-attempt-1',
			laneId: 'canary-1',
			workflowLane: DIM_F,
			candidateId: 'FINAL-DIM-F',
		});

		await expect(
			assertPrReviewBaseCoverageSettled(directory, sessionID),
		).resolves.toMatchObject({ prHeadSha: HEAD_SHA });

		await expect(
			enforcePrReviewBaseDimensions(
				directory,
				sessionID,
				[{ laneId: 'fanout-1', workflowLane: DIM_B }],
				{
					batchId: 'fanout-attempt-1',
					prHeadSha: HEAD_SHA,
					prReviewWaveStage: 'fanout',
					prReviewWaveAttempt: 1,
					prReviewResiliencePolicy: RESILIENCE_POLICY,
				},
			),
		).rejects.toThrow('has no remaining unresolved obligations for fanout');
	});

	test('same-session concurrent staged canary contenders launch at most one child and record at most one batch', async () => {
		let created = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({ data: { id: `lane-session-${created++}` } })),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});

		const contenders = await Promise.all([
			executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:base',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					pr_review_wave_stage: 'canary',
					pr_review_wave_attempt: 0,
					max_concurrent: 1,
					lanes: [lane('contender-a', DIM_A)],
				},
				directory,
				{ sessionID: 'review-session-race' },
			),
			executeDispatchLanesAsync(
				{
					mode: 'swarm-pr-review:base',
					pr_head_sha: HEAD_SHA,
					base_sha: BASE_SHA,
					base_ref: 'origin/main',
					pr_review_wave_stage: 'canary',
					pr_review_wave_attempt: 0,
					max_concurrent: 1,
					lanes: [lane('contender-b', DIM_B)],
				},
				directory,
				{ sessionID: 'review-session-race' },
			),
		]);

		expect(contenders.filter((result) => result.success).length).toBe(1);
		expect(created).toBe(1);
		const state = await readPrWorkflowGateState(
			directory,
			'review-session-race',
		);
		expect(state?.prReviewBaseDispatches).toHaveLength(1);
		expect(state?.prReviewResilience?.attempts).toHaveLength(1);
		expect(
			contenders.some(
				(result) =>
					!result.success &&
					(/concurrently|not yet proven successful or live/.test(
						String(result.message),
					) ||
						result.failure_class === 'invalid_args'),
			),
		).toBe(true);
		expect(
			findByBatchId(
				directory,
				String(state?.prReviewBaseDispatches?.[0]?.batchId),
				{ parentSessionId: 'review-session-race' },
			),
		).toHaveLength(1);
	});
});
