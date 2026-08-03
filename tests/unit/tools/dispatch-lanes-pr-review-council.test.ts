import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	assertPrReviewValidationSettled,
	bindPrReviewBase,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	prReviewDiscoveryArtifactCoversLane,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';

const SESSION_ID = 'review-council';
const HEAD_SHA = 'abc123';
const REVIEW_SCOPE = `complete PR diff def456...${HEAD_SHA}`;
const REVISION_DIGEST = 'review-revision';
let directory = '';
let createdSessions = 0;
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalGetGeneratedAgentNames = dispatchInternals.getGeneratedAgentNames;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalGateRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;
const originalDispatchRevisionDigestAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalDispatchMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'dispatch-review-council-')),
	);
	createdSessions = 0;
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	// The gate/dispatch bind path resolves Git off the blocking spawn (async).
	// The gate seam keeps a live sync twin (used by its override-detection path),
	// so route the gate async resolvers through the sync stubs above; the dispatch
	// seam is async-only, so stub those directly.
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		REVISION_DIGEST;
	dispatchInternals.resolveExactMergeBaseAsync = async () => 'def456';
	dispatchInternals.getGeneratedAgentNames = () => [
		'council_generalist',
		'reviewer',
	];
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `child-${++createdSessions}` },
			error: undefined,
		})),
		prompt: mock(async () => ({ data: undefined, error: undefined })),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalGateRevisionDigest;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalDispatchRevisionDigestAsync;
	dispatchInternals.resolveExactMergeBaseAsync = originalDispatchMergeBaseAsync;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	dispatchInternals.getGeneratedAgentNames = originalGetGeneratedAgentNames;
	await fs.rm(directory, { recursive: true, force: true });
});

async function establishReviewPrerequisites(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	await bindPrReviewBase(directory, SESSION_ID, {
		prHeadSha: HEAD_SHA,
		baseRef: 'origin/main',
		baseSha: 'def456',
	});
	const lanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, lanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
	});
	for (const [index, lane] of lanes.entries()) {
		const correlationId = `base-${index}`;
		const text = `[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence\nC-${index} | ${lane.workflowLane} | LOW | correctness | file.ts:1 | claim | evidence | impact | LOW`;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: SESSION_ID,
			callID: `call-${index}`,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'base-all',
			laneId: lane.laneId,
			mode: 'swarm-pr-review:base',
			workflowLane: lane.workflowLane,
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: REVIEW_SCOPE,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId: 'base-all',
			laneId: lane.laneId,
			agent: 'explorer',
			role: 'explorer',
			sessionId: correlationId,
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-review:base',
			workflowLane: lane.workflowLane,
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			scope: REVIEW_SCOPE,
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
		});
	}
	const triggerRows: Array<Record<string, string>> = [];
	for (const [
		index,
		workflowLane,
	] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
		const batchId = `micro-${index}`;
		const laneId = `micro-lane-${index}`;
		const correlationId = `micro-session-${index}`;
		const text = `[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence\n[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: SESSION_ID,
			callID: batchId,
			normalizedAgent: 'explorer',
			swarmPrefixedAgent: 'explorer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId,
			mode: 'swarm-pr-review:micro',
			workflowLane,
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: REVIEW_SCOPE,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId,
			laneId,
			agent: 'explorer',
			role: 'explorer',
			sessionId: correlationId,
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-review:micro',
			workflowLane,
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			scope: REVIEW_SCOPE,
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
		});
		triggerRows.push({
			trigger_id: workflowLane,
			result: 'MATCHED',
			evidence: `Test fixture evidence for ${workflowLane}`,
			source_batch_id: batchId,
			source_lane_id: laneId,
		});
	}
	const triggerRelative = path.join('pr-review', 'run', 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({ rows: triggerRows }),
		'utf-8',
	);
	await markPrReviewTriggerEvaluationComplete(
		directory,
		SESSION_ID,
		triggerRelative,
	);
}

describe('PR review council mechanical dispatch', () => {
	test('requires every micro retry lane to resolve to the explorer role', async () => {
		await establishReviewPrerequisites();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:micro',
				pr_head_sha: HEAD_SHA,
				base_sha: 'def456',
				base_ref: 'origin/main',
				trigger_evaluation: PR_REVIEW_REQUIRED_MICRO_LANE_IDS.map(
					(triggerId) => ({
						trigger_id: triggerId,
						result: 'MATCHED' as const,
						evidence: `mandatory review focus for ${triggerId}`,
					}),
				),
				lanes: [
					{
						id: 'micro-retry',
						agent: 'reviewer',
						prompt: 'Retry the failed micro-lane review.',
						workflow_lane: PR_REVIEW_REQUIRED_MICRO_LANE_IDS[0],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'PR_REVIEW micro lane "micro-retry" must use the explorer role',
		);
	});

	test('rejects a marker header without a data row or lane-bound CLEAN attestation', () => {
		expect(
			prReviewDiscoveryArtifactCoversLane(
				'[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence | impact | confidence',
				'intent-architecture',
			),
		).toBe(false);
		const clean =
			'[CLEAN] | intent-architecture | all changed architecture paths | no candidate survived caller and sibling checks';
		expect(
			prReviewDiscoveryArtifactCoversLane(clean, 'intent-architecture'),
		).toBe(false);
		expect(
			prReviewDiscoveryArtifactCoversLane(
				`[CANDIDATE] | candidate_id | lane | severity | category | file:line | claim | evidence_summary | impact_context | confidence\n${clean}`,
				'intent-architecture',
			),
		).toBe(true);
	});

	test('requires one parseable reviewer verdict per structurally assigned item', async () => {
		await establishReviewPrerequisites();
		const reviewItems = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);
		await expect(
			recordPrReviewValidationBatch(
				directory,
				SESSION_ID,
				'reviewer',
				[
					{
						laneId: 'duplicate-a',
						workflowLane: 'duplicate-a',
						reviewItemIds: ['C-001'],
					},
					{
						laneId: 'duplicate-b',
						workflowLane: 'duplicate-b',
						reviewItemIds: ['C-001'],
					},
				],
				{ batchId: 'duplicate-review', prHeadSha: HEAD_SHA },
			),
		).rejects.toThrow('duplicate');
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-two',
					workflowLane: 'review-two',
					reviewItemIds: reviewItems,
				},
			],
			{ batchId: 'review-two', prHeadSha: HEAD_SHA },
		);
		const correlationId = 'review-two-session';
		const text =
			'[REVIEWED] | C-001 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer';
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: SESSION_ID,
			callID: 'review-two',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: 'review-two',
			laneId: 'review-two',
			mode: 'swarm-pr-review:reviewer',
			workflowLane: 'review-two',
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash: null,
				prHeadSha: HEAD_SHA,
				scope: REVIEW_SCOPE,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId: 'review-two',
			laneId: 'review-two',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: correlationId,
			parentSessionId: SESSION_ID,
			mode: 'swarm-pr-review:reviewer',
			workflowLane: 'review-two',
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION_DIGEST,
			scope: REVIEW_SCOPE,
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
		});
		await expect(
			assertPrReviewValidationSettled(directory, SESSION_ID, 'reviewer'),
		).rejects.toThrow('one fully successful exact batch');
	});

	test('accepts structured council mode and blocks reviewer dispatch until council settles', async () => {
		await establishReviewPrerequisites();

		const council = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:council',
				pr_head_sha: HEAD_SHA,
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'council-generalist',
						agent: 'council_generalist',
						prompt: 'Audit the candidate ledger independently.',
						workflow_lane: 'council-generalist',
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(council.success).toBe(true);
		expect(council.pending).toBe(1);
		const councilRecord = readDelegations(directory).find(
			(record) => record.batchId === council.batch_id,
		);
		expect(councilRecord?.workspace).toMatchObject({
			gitHead: HEAD_SHA,
			prHeadSha: HEAD_SHA,
		});

		const reviewer = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: HEAD_SHA,
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'reviewer-one',
						agent: 'reviewer',
						prompt: 'Classify all candidates.',
						workflow_lane: 'reviewer-one',
						review_item_ids: ['C-001'],
					},
				],
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(reviewer.success).toBe(false);
		expect(reviewer.message).toContain('council obligations');
	});
});
