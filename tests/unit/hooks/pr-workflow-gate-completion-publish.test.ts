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
	completePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	enforcePrWorkflowToolBefore,
	readPrWorkflowGateState,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { withFrozenClock } from '../../helpers/test-clock.js';

// Split from pr-workflow-gate-completion.test.ts (FR-006): publication-arm
// immutability, exact-push gating, and terminal CAS completion behavior.

const SESSION_ID = 'feedback-completion';
const HEAD_SHA = 'abc123';
const POST_COMMIT_SHA = 'def456';
const REVISION = 'revision-1';
let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
const originalResolveCurrentUpstreamRemoteRef =
	_test_exports.resolveCurrentUpstreamRemoteRef;
const originalResolveCurrentUpstreamPushTarget =
	_test_exports.resolveCurrentUpstreamPushTarget;
const originalResolveExactRemoteBranchHead =
	_test_exports.resolveExactRemoteBranchHead;
const originalResolveCommitCountSince = _test_exports.resolveCommitCountSince;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsExactSingleChildCommit =
	_test_exports.resolveIsExactSingleChildCommit;
const originalResolveRevision = _test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveRemoteRefs = _test_exports.resolveRemoteRefsContainingHead;
const originalResolveCurrentUpstreamPushTargetAsync =
	_test_exports.resolveCurrentUpstreamPushTargetAsync;
const originalResolveExactRemoteBranchHeadAsync =
	_test_exports.resolveExactRemoteBranchHeadAsync;
const originalResolveCommitCountSinceAsync =
	_test_exports.resolveCommitCountSinceAsync;
const originalResolveIsExactSingleChildCommitAsync =
	_test_exports.resolveIsExactSingleChildCommitAsync;
const originalResolveRemoteRefsContainingHeadAsync =
	_test_exports.resolveRemoteRefsContainingHeadAsync;
const originalResolveRemoteUrlIdentityAsync =
	_test_exports.resolveRemoteUrlIdentityAsync;
const originalResolveCurrentLocalHeadRefAsync =
	_test_exports.resolveCurrentLocalHeadRefAsync;

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-completion-publish-')),
	);
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolveCurrentUpstreamRemoteRef = () =>
		'refs/remotes/origin/pr-head';
	_test_exports.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	_test_exports.resolveExactRemoteBranchHead = () => POST_COMMIT_SHA;
	_test_exports.resolveCommitCountSince = () => 1;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsExactSingleChildCommit = () => true;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION;
	_test_exports.resolveRemoteRefsContainingHead = (_directory, headSha) =>
		headSha === HEAD_SHA ? ['refs/remotes/origin/pr-head'] : [];
	_test_exports.resolveCurrentGitHeadAsync = async (dir) =>
		_test_exports.resolveCurrentGitHead(dir);
	_test_exports.resolveIsWorkingTreeCleanAsync = async (dir) =>
		_test_exports.resolveIsWorkingTreeClean(dir);
	_test_exports.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		_test_exports.resolveCurrentUpstreamPushTarget(dir);
	_test_exports.resolveExactRemoteBranchHeadAsync = async (...a) =>
		_test_exports.resolveExactRemoteBranchHead(...a);
	_test_exports.resolveCommitCountSinceAsync = async (...a) =>
		_test_exports.resolveCommitCountSince(...a);
	_test_exports.resolveIsExactSingleChildCommitAsync = async (...a) =>
		_test_exports.resolveIsExactSingleChildCommit(...a);
	_test_exports.resolveRemoteRefsContainingHeadAsync = async (...a) =>
		_test_exports.resolveRemoteRefsContainingHead(...a);
	// Issue #2108: the generation identity requires the local branch ref and
	// the credential-redacted remote URL identity; both are fail-closed at
	// arming when unresolvable, so the fixture pins them.
	_test_exports.resolveRemoteUrlIdentityAsync = async () =>
		'https://***@github.com/example/repo.git';
	_test_exports.resolveCurrentLocalHeadRefAsync = async () =>
		'refs/heads/pr-head';
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resolveCurrentUpstreamRemoteRef =
		originalResolveCurrentUpstreamRemoteRef;
	_test_exports.resolveCurrentUpstreamPushTarget =
		originalResolveCurrentUpstreamPushTarget;
	_test_exports.resolveExactRemoteBranchHead =
		originalResolveExactRemoteBranchHead;
	_test_exports.resolveCommitCountSince = originalResolveCommitCountSince;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsExactSingleChildCommit =
		originalResolveIsExactSingleChildCommit;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	_test_exports.resolveRemoteRefsContainingHead = originalResolveRemoteRefs;
	_test_exports.resolveCurrentUpstreamPushTargetAsync =
		originalResolveCurrentUpstreamPushTargetAsync;
	_test_exports.resolveExactRemoteBranchHeadAsync =
		originalResolveExactRemoteBranchHeadAsync;
	_test_exports.resolveCommitCountSinceAsync =
		originalResolveCommitCountSinceAsync;
	_test_exports.resolveIsExactSingleChildCommitAsync =
		originalResolveIsExactSingleChildCommitAsync;
	_test_exports.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsContainingHeadAsync;
	_test_exports.resolveRemoteUrlIdentityAsync =
		originalResolveRemoteUrlIdentityAsync;
	_test_exports.resolveCurrentLocalHeadRefAsync =
		originalResolveCurrentLocalHeadRefAsync;
	_test_exports.beforeTerminalClear = undefined;
	await fs.rm(directory, { recursive: true, force: true });
});

async function persistGateArtifact(
	batchId: string,
	phase:
		| 'stage-b-reviewer'
		| 'stage-b-test'
		| 'closeout-reviewer'
		| 'closeout-critic',
	role: string,
	text: string,
	subagentSessionId?: string,
): Promise<void> {
	const correlationId = `${batchId}-lane`;
	await recordPendingDelegation(directory, {
		correlationId,
		jobId: null,
		subagentSessionId: subagentSessionId ?? correlationId,
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
		sessionId: subagentSessionId ?? correlationId,
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

async function prepareReadyToPublishState(): Promise<void> {
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
	for (const [phase, role, text] of [
		[
			'stage-b-reviewer',
			'reviewer',
			'[STAGE-B-REVIEW] | FB-001 | APPROVE | evidence',
		],
		[
			'stage-b-test',
			'test_engineer',
			'[STAGE-B-TEST] | FB-001 | PASS | evidence',
		],
		[
			'closeout-reviewer',
			'reviewer',
			'[CLOSEOUT-REVIEW] | FB-001 | APPROVE | evidence',
		],
		[
			'closeout-critic',
			'critic_oversight',
			'[CLOSEOUT-CRITIC] | FB-001 | APPROVE | evidence',
		],
	] as const) {
		const batchId = `batch-${phase}`;
		await recordPrFeedbackGateBatch(
			directory,
			SESSION_ID,
			phase,
			{ laneId: phase, ownedItemIds: ['FB-001'] },
			{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION },
		);
		await persistGateArtifact(batchId, phase, role, text);
	}
	_test_exports.resolveCurrentGitHead = () => POST_COMMIT_SHA;
	await expect(
		completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
	).resolves.toBe('ready-to-publish');
}

describe('PR workflow terminal completion - publication and terminal clear', () => {
	test('allows only the exact approved push after publication arms', async () => {
		await prepareReadyToPublishState();
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: 'git commit --amend --no-edit',
			}),
		).rejects.toThrow('approved commit is immutable');
		for (const command of [
			'git push origin HEAD',
			`git push --force origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git push --mirror origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git push other ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git push origin ${POST_COMMIT_SHA}:refs/heads/unrelated`,
			`git push origin +${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git -C . push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			`git fetch . ${POST_COMMIT_SHA}:refs/remotes/origin/pr-head`,
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow('only the exact approved push');
		}
		await expect(
			enforcePrWorkflowToolBefore(
				directory,
				SESSION_ID,
				'github_add_pull_request_review_comment',
				{},
			),
		).rejects.toThrow('rejects unclassified plugin/MCP tools');
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			}),
		).resolves.toBeUndefined();
		// Issue #2108: proven content drift no longer throws-and-forgets — the
		_test_exports.resolvePrWorkflowRevisionDigest = () =>
			'edited-after-approval';
		// generation is DURABLY invalidated (approvals superseded, mirror
		// cleared) and the error names the recovery path. The full
		// head/worktree/upstream drift matrix lives in
		// pr-workflow-publication-invalidation.test.ts.
		_test_exports.resolvePrWorkflowRevisionDigest = () =>
			'edited-after-approval';
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			}),
		).rejects.toThrow(
			'was INVALIDATED because approved content identity drifted',
		);
		const invalidated = await readPrWorkflowGateState(directory, SESSION_ID);
		expect(invalidated?.prFeedbackPublication?.active?.state).toBe(
			'invalidated',
		);
		expect(invalidated?.prFeedbackReadyToPublish).toBeUndefined();
		expect(invalidated?.prFeedbackStageA).toBeUndefined();
		expect(invalidated?.prFeedbackGateBatches).toBeUndefined();
		expect(invalidated?.prFeedbackScopes).toBeUndefined();
	});

	test('requires exact approved remote alignment and terminal CAS before clearing state', async () => {
		await prepareReadyToPublishState();
		// Issue #2108: completion requires the exact approved push to have been
		// admitted (durable attempt) before it may publish.
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('requires the exact approved push');
		_test_exports.resolveRemoteRefsContainingHead = () => [
			'refs/remotes/origin/pr-head',
		];
		_test_exports.resolveExactRemoteBranchHead = () => 'remote-not-approved';
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: `git push origin ${POST_COMMIT_SHA}:refs/heads/pr-head`,
			}),
		).resolves.toBeUndefined();
		// Identity intact; the remote branch head is NOT at the approved commit.
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('intended remote-tracking ref');
		_test_exports.resolveExactRemoteBranchHead = () => POST_COMMIT_SHA;
		_test_exports.resolveRemoteRefsContainingHead = () => [
			'refs/remotes/origin/unrelated-branch',
		];
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('intended remote-tracking ref');
		_test_exports.resolveRemoteRefsContainingHead = () => [
			'refs/remotes/origin/pr-head',
		];
		const statePath = path.join(
			directory,
			'.swarm',
			_test_exports.workflowGateStateRelativePath(SESSION_ID),
		);
		_test_exports.beforeTerminalClear = async () => {
			const raw = JSON.parse(await fs.readFile(statePath, 'utf-8')) as {
				revision: number;
				updatedAt: string;
			};
			raw.revision += 1;
			raw.updatedAt = withFrozenClock(() => new Date().toISOString());
			await fs.writeFile(statePath, JSON.stringify(raw), 'utf-8');
			_test_exports.resetTrackedStateCache();
		};
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('state changed during terminal completion');
		await expect(
			readPrWorkflowGateState(directory, SESSION_ID),
		).resolves.not.toBeNull();
		_test_exports.beforeTerminalClear = undefined;
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).resolves.toBe('completed');
		await expect(
			readPrWorkflowGateState(directory, SESSION_ID),
		).resolves.toBeNull();
	});
});
