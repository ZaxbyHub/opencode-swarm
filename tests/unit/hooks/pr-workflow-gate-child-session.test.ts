import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrFeedbackGatePhaseSettled,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';

const SESSION_ID = 'feedback-child-session';
const HEAD_SHA = 'abc123';
const REVISION = 'revision-1';
const SHARED_CHILD_SESSION_ID = 'shared-child-session';
let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevision = _test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveCurrentUpstreamPushTarget =
	_test_exports.resolveCurrentUpstreamPushTarget;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefsContainingHead =
	_test_exports.resolveRemoteRefsContainingHead;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-child-session-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
	_test_exports.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-branch',
		remoteTrackingRef: 'refs/remotes/origin/pr-branch',
	});
	_test_exports.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		_test_exports.resolveCurrentUpstreamPushTarget(dir);
	_test_exports.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-branch',
	];
	_test_exports.resolveRemoteRefsContainingHeadAsync = async (...a) =>
		_test_exports.resolveRemoteRefsContainingHead(...a);
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resolveCurrentUpstreamPushTarget =
		originalResolveCurrentUpstreamPushTarget;
	_test_exports.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	_test_exports.resolveRemoteRefsContainingHead =
		originalResolveRemoteRefsContainingHead;
	_test_exports.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistFeedbackArtifact(): Promise<void> {
	const correlationId = 'verify-complete-lane';
	const text = '[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence';
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: SESSION_ID,
		callID: 'verify-complete',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		batchId: 'verify-complete',
		laneId: 'verify',
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: null,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId: 'verify-complete',
		laneId: 'verify',
		agent: 'reviewer',
		role: 'reviewer',
		sessionId: correlationId,
		parentSessionId: SESSION_ID,
		mode: 'swarm-pr-feedback:verification',
		workflowLane: 'verify',
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION,
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

async function persistGateArtifact(
	batchId: string,
	phase: 'stage-b-reviewer' | 'stage-b-test',
	role: 'reviewer' | 'test_engineer',
	text: string,
): Promise<void> {
	const correlationId = `${batchId}-lane`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: SHARED_CHILD_SESSION_ID,
		parentSessionId: SESSION_ID,
		callID: batchId,
		normalizedAgent: role,
		swarmPrefixedAgent: role,
		planTaskId: null,
		evidenceTaskId: null,
		batchId,
		laneId: phase,
		mode: `swarm-pr-feedback:${phase}`,
		workflowLane: phase,
		workspace: {
			directory,
			gitHead: HEAD_SHA,
			dirtyHash: REVISION,
			prHeadSha: HEAD_SHA,
			scope: null,
		},
	});
	const stored = storeLaneOutput(directory, {
		batchId,
		laneId: phase,
		agent: role,
		role,
		sessionId: SHARED_CHILD_SESSION_ID,
		parentSessionId: SESSION_ID,
		mode: `swarm-pr-feedback:${phase}`,
		workflowLane: phase,
		prHeadSha: HEAD_SHA,
		gitHead: HEAD_SHA,
		revisionDigest: REVISION,
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

describe('PR workflow child-session independence', () => {
	test('rejects reuse of one child session across independent feedback phases', async () => {
		await activatePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK');
		await declarePrFeedbackInventory(directory, SESSION_ID, ['FB-001'], {
			prHeadSha: HEAD_SHA,
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			SESSION_ID,
			[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
			{ batchId: 'verify-complete', prHeadSha: HEAD_SHA },
		);
		await persistFeedbackArtifact();
		await recordPrFeedbackStageA(directory, SESSION_ID, REVISION, [
			{ category: 'build', command: ['build'], durationMs: 1 },
			{ category: 'typecheck', command: ['typecheck'], durationMs: 1 },
			{ category: 'lint', command: ['lint'], durationMs: 1 },
			{
				category: 'diff-check',
				command: ['git', 'diff', '--check'],
				durationMs: 1,
			},
			{
				category: 'reproduction',
				command: ['test', 'regression'],
				targets: ['regression'],
				feedbackTargets: [
					{
						feedbackItemId: 'FB-001',
						target: 'regression',
						expectedBehavior: 'regression remains fixed',
					},
				],
				durationMs: 1,
			},
		]);
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			'stage-b-reviewer',
			{ laneId: 'stage-b-reviewer', ownedItemIds: ['FB-001'] },
			{
				batchId: 'reuse-review',
				prHeadSha: HEAD_SHA,
				revisionDigest: REVISION,
			},
		);
		await persistGateArtifact(
			'reuse-review',
			'stage-b-reviewer',
			'reviewer',
			'[STAGE-B-REVIEW] | FB-001 | APPROVE | evidence',
		);
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			'stage-b-test',
			{ laneId: 'stage-b-test', ownedItemIds: ['FB-001'] },
			{ batchId: 'reuse-test', prHeadSha: HEAD_SHA, revisionDigest: REVISION },
		);
		await persistGateArtifact(
			'reuse-test',
			'stage-b-test',
			'test_engineer',
			'[STAGE-B-TEST] | FB-001 | PASS | evidence',
		);
		await expect(
			assertPrFeedbackGatePhaseSettled(directory, SESSION_ID, 'stage-b-test'),
		).rejects.toThrow('reused child session');
	});
});
