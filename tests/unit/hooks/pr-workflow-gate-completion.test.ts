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
		mkdtempSync(path.join(os.tmpdir(), 'pr-gate-completion-')),
	);
	_test_exports.resetTrackedStateCache();
	// Issue #2251: completion settles lanes, and settlement now probes host
	// session liveness. Pin "no host" so a `swarmState.opencodeClient` leaked by
	// another file cannot make this suite order-dependent (or make it wait out
	// the probe's real 5s deadline against bun's 5s per-test timeout).
	_test_exports.getSessionOps = () => null;
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
	// Gate bind/verify resolves Git off the blocking spawn; route the async
	// resolvers through the (per-test-mutated) sync stubs above.
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
	// Issue #2108: generation identity components are fail-closed at arming;
	// pin them like every other resolver.
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

describe('PR workflow terminal completion', () => {
	test('requires ordered, content-bound Stage A, Stage B, and closeout artifacts before publication arms', async () => {
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
		for (const command of [
			'git push origin HEAD',
			'git -C . push origin HEAD',
			'cmd /c git push origin HEAD',
			'gh api repos/o/r/issues/1 --method PATCH -f title=changed',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow('not armed');
		}
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('Stage A');
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
			{ batchId: 'bad-review', prHeadSha: HEAD_SHA, revisionDigest: REVISION },
		);
		await persistGateArtifact(
			'bad-review',
			'stage-b-reviewer',
			'reviewer',
			'[STAGE-B-REVIEW] | FB-001 | NEEDS_REVISION | not APPROVE yet',
		);
		await expect(
			recordPrFeedbackGateBatch(
				directory,
				SESSION_ID,
				'stage-b-test',
				{ laneId: 'stage-b-test', ownedItemIds: ['FB-001'] },
				{
					batchId: 'test-too-early',
					prHeadSha: HEAD_SHA,
					revisionDigest: REVISION,
				},
			),
		).rejects.toThrow('positive verdict');
		const phases = [
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
		] as const;
		for (const [phase, role, text] of phases) {
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
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: 'git push origin HEAD',
			}),
		).rejects.toThrow('not armed');
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: 'git commit -m feedback-fix',
			}),
		).resolves.toBeUndefined();
		for (const command of [
			'git ci -m bypass',
			'git -c alias.ci=commit ci -m bypass',
			'curl -X POST https://example.invalid/publish',
			'npm run publish',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow('BLOCKED: PR_FEEDBACK');
		}
		await expect(
			enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
				command: 'git commit -m feedback-fix && node scripts/mutate.js',
			}),
		).rejects.toThrow('standalone shell commands');
		for (const command of [
			'git commit --allow-empty -m bypass',
			'git commit --amend --no-edit',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow('standalone git commit');
		}
		for (const command of [
			'git commit -m "fix $(node scripts/mutate.js)"',
			'git commit -m "fix `node scripts/mutate.js`"',
		]) {
			await expect(
				enforcePrWorkflowToolBefore(directory, SESSION_ID, 'shell', {
					command,
				}),
			).rejects.toThrow('standalone shell commands');
		}
		_test_exports.resolveCurrentGitHead = () => POST_COMMIT_SHA;
		// Issue #2131 C1 evolved the zero-commit contract: count 0 now routes
		// to the verified-no-change terminal, whose guards fail closed first (a
		// diverged HEAD gets the precise remediation message). Counts 2/null
		// still hit the exactly-one-commit rule.
		_test_exports.resolveCommitCountSince = () => 0;
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('history diverged');
		for (const commitCount of [2, null]) {
			_test_exports.resolveCommitCountSince = () => commitCount;
			await expect(
				completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
			).rejects.toThrow('exactly one descendant commit');
		}
		_test_exports.resolveCommitCountSince = () => 1;
		_test_exports.resolveIsExactSingleChildCommit = () => false;
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('non-merge direct child');
		_test_exports.resolveIsExactSingleChildCommit = () => true;
		_test_exports.resolveIsWorkingTreeClean = () => false;
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).rejects.toThrow('clean index and working tree');
		_test_exports.resolveIsWorkingTreeClean = () => true;
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_FEEDBACK', HEAD_SHA),
		).resolves.toBe('ready-to-publish');
		await expect(
			readPrWorkflowGateState(directory, SESSION_ID),
		).resolves.not.toBeNull();
	});
});
