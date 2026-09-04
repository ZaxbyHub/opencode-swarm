/**
 * Shared fixtures for the issue #2108 publication-generation test files.
 *
 * Each test creates its OWN fixture instance (`createPublicationFixture`) so
 * parallel test files never share directory or seam-mutator state (bun runs
 * files in one process; module-level mutable state would race teardowns).
 * The seam snapshots remain process-global exactly like every existing
 * `_test_exports` suite.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	completePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	readPrWorkflowGateState,
	recordPrFeedbackGateBatch,
	recordPrFeedbackStageA,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

export const HEAD_SHA = 'abc123';
export const POST_COMMIT_SHA = 'def456';
export const REVISION = 'revision-1';
export const REMOTE_URL_IDENTITY = 'https://***@github.com/example/repo.git';
export const LOCAL_HEAD_REF = 'refs/heads/pr-head';
export const UPSTREAM_TARGET = {
	remoteName: 'origin',
	remoteBranchRef: 'refs/heads/pr-head',
	remoteTrackingRef: 'refs/remotes/origin/pr-head',
} as const;

export interface PublicationFixture {
	directory: string;
	prepareArmedGeneration(sessionId: string, sessionSeq?: number): Promise<void>;
	readActive(sessionId: string): Promise<{
		state?: ReturnType<typeof readPrWorkflowGateState> extends Promise<infer T>
			? T
			: never;
		publication?: NonNullable<
			Awaited<ReturnType<typeof readPrWorkflowGateState>>
		>['prFeedbackPublication'];
		active?: NonNullable<
			NonNullable<
				Awaited<ReturnType<typeof readPrWorkflowGateState>>
			>['prFeedbackPublication']
		>['active'];
	}>;
	fixtureStatePath(sessionId: string): string;
	mutators: {
		head(value: string): void;
		digest(value: string): void;
		remoteHead(value: string | null): void;
		upstream(
			target: {
				remoteName: string;
				remoteBranchRef: string;
				remoteTrackingRef: string;
			} | null,
		): void;
		remoteUrl(value: string | null): void;
		worktreeClean(value: boolean): void;
	};
	teardown(): Promise<void>;
}

export async function createPublicationFixture(): Promise<PublicationFixture> {
	const directory = canonicalMkdtemp('pr-publication-');
	let currentHead = HEAD_SHA;
	let revisionDigest = REVISION;
	let remoteBranchHead: string | null = POST_COMMIT_SHA;
	// Snapshot for teardown restore (PR #2422 review PRR-011): the fixture
	// patches ~20 process-global _test_exports seams; without a restore, any
	// later test file in the same bun process inherits the stubs. CI runs
	// per-file processes, but local batch runs and the coverage shard do not.
	const seamSnapshot = { ..._test_exports };

	const installSeams = (): void => {
		currentHead = HEAD_SHA;
		revisionDigest = REVISION;
		remoteBranchHead = POST_COMMIT_SHA;
		_test_exports.resetTrackedStateCache();
		_test_exports.getSessionOps = () => null;
		_test_exports.resolveCurrentGitHead = () => currentHead;
		_test_exports.resolveCurrentGitHeadAsync = async () => currentHead;
		_test_exports.resolveIsWorkingTreeClean = () => true;
		_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
		_test_exports.resolveIsExactSingleChildCommit = () => true;
		_test_exports.resolveIsExactSingleChildCommitAsync = async () => true;
		_test_exports.resolveCommitCountSince = () => 1;
		_test_exports.resolveCommitCountSinceAsync = async () => 1;
		_test_exports.resolvePrWorkflowRevisionDigest = () => revisionDigest;
		_test_exports.resolveCurrentUpstreamRemoteRef = () =>
			'refs/remotes/origin/pr-head';
		_test_exports.resolveCurrentUpstreamPushTarget = () => ({
			remoteName: UPSTREAM_TARGET.remoteName,
			remoteBranchRef: UPSTREAM_TARGET.remoteBranchRef,
			remoteTrackingRef: UPSTREAM_TARGET.remoteTrackingRef,
		});
		_test_exports.resolveCurrentUpstreamPushTargetAsync = async () => ({
			remoteName: UPSTREAM_TARGET.remoteName,
			remoteBranchRef: UPSTREAM_TARGET.remoteBranchRef,
			remoteTrackingRef: UPSTREAM_TARGET.remoteTrackingRef,
		});
		_test_exports.resolveRemoteRefsContainingHead = (
			_dir: string,
			sha: string,
		) =>
			sha === HEAD_SHA || sha === POST_COMMIT_SHA
				? ['refs/remotes/origin/pr-head']
				: [];
		_test_exports.resolveRemoteRefsContainingHeadAsync = async (
			_dir: string,
			sha: string,
		) =>
			sha === HEAD_SHA || sha === POST_COMMIT_SHA
				? ['refs/remotes/origin/pr-head']
				: [];
		_test_exports.resolveExactRemoteBranchHead = () => remoteBranchHead;
		_test_exports.resolveExactRemoteBranchHeadAsync = async () =>
			remoteBranchHead;
		_test_exports.resolveRemoteUrlIdentity = () => REMOTE_URL_IDENTITY;
		_test_exports.resolveRemoteUrlIdentityAsync = async () =>
			REMOTE_URL_IDENTITY;
		_test_exports.resolveCurrentLocalHeadRefAsync = async () => LOCAL_HEAD_REF;
	};
	installSeams();

	const fixture: PublicationFixture = {
		directory,
		mutators: {
			head(value: string) {
				currentHead = value;
			},
			digest(value: string) {
				revisionDigest = value;
			},
			remoteHead(value: string | null) {
				remoteBranchHead = value;
			},
			upstream(target) {
				_test_exports.resolveCurrentUpstreamPushTarget = () => target;
				_test_exports.resolveCurrentUpstreamPushTargetAsync = async () =>
					target;
			},
			remoteUrl(value: string | null) {
				_test_exports.resolveRemoteUrlIdentity = () => value;
				_test_exports.resolveRemoteUrlIdentityAsync = async () => value;
			},
			worktreeClean(value: boolean) {
				_test_exports.resolveIsWorkingTreeClean = () => value;
				_test_exports.resolveIsWorkingTreeCleanAsync = async () => value;
			},
		},
		fixtureStatePath(sessionId: string): string {
			const relative = _test_exports.workflowGateStateRelativePath(sessionId);
			return path.join(directory, '.swarm', relative);
		},
		async readActive(sessionId: string) {
			const state = await readPrWorkflowGateState(directory, sessionId);
			return {
				state,
				publication: state?.prFeedbackPublication,
				active: state?.prFeedbackPublication?.active,
			};
		},
		async prepareArmedGeneration(
			sessionId: string,
			sessionSeq = 0,
		): Promise<void> {
			const suffix = sessionSeq > 0 ? `-${sessionSeq}` : '';
			// Re-arming on an already-active session (generation N+1) re-walks
			// the ladder from the intake head binding.
			currentHead = HEAD_SHA;
			await activatePrWorkflow(directory, sessionId, 'PR_FEEDBACK');
			await declarePrFeedbackInventory(directory, sessionId, ['FB-001'], {
				prHeadSha: HEAD_SHA,
			});
			await enforcePrFeedbackVerificationOwnership(
				directory,
				sessionId,
				[{ laneId: 'verify', ownedItemIds: ['FB-001'] }],
				{ batchId: `verify-complete${suffix}`, prHeadSha: HEAD_SHA },
			);
			await persistVerifiedLane(
				`verify-complete${suffix}`,
				'verify',
				'swarm-pr-feedback:verification',
				'reviewer',
				'[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence',
				null,
				sessionId,
				suffix,
			);
			await recordPrFeedbackStageA(directory, sessionId, REVISION, [
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
			for (const [phase, agent, verdict] of [
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
				const batchId = `batch-${phase}${suffix}`;
				await recordPrFeedbackGateBatch(
					directory,
					sessionId,
					phase,
					{ laneId: phase, ownedItemIds: ['FB-001'] },
					{ batchId, prHeadSha: HEAD_SHA, revisionDigest: REVISION },
				);
				await persistVerifiedLane(
					batchId,
					phase,
					`swarm-pr-feedback:${phase}`,
					agent,
					verdict,
					REVISION,
					sessionId,
					suffix,
				);
			}
			currentHead = POST_COMMIT_SHA;
			const status = await completePrWorkflow(
				directory,
				sessionId,
				'PR_FEEDBACK',
				HEAD_SHA,
			);
			if (status !== 'ready-to-publish') {
				throw new Error(`fixture arming failed: ${status}`);
			}
		},
		async teardown(): Promise<void> {
			// Restore EVERY seam this fixture (or a test mutating seams directly)
			// touched, then drop the cache so no stubbed resolver survives into
			// another suite in the same process.
			Object.assign(_test_exports, seamSnapshot);
			_test_exports.resetTrackedStateCache();
			closeAllProjectDbs();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};

	async function persistVerifiedLane(
		batchId: string,
		laneId: string,
		mode: string,
		agent: string,
		text: string,
		dirtyHash: string | null,
		sessionId: string,
		suffix: string,
	): Promise<void> {
		const role = agent;
		await recordPendingDelegation(directory, {
			correlationId: batchId,
			jobId: null,
			subagentSessionId: `${batchId}-sess`,
			parentSessionId: sessionId,
			callID: `call-${batchId}`,
			normalizedAgent: agent,
			swarmPrefixedAgent: agent,
			planTaskId: null,
			evidenceTaskId: null,
			batchId,
			laneId,
			mode,
			workflowLane: laneId,
			workspace: {
				directory,
				gitHead: HEAD_SHA,
				dirtyHash,
				prHeadSha: HEAD_SHA,
				scope: null,
			},
		});
		const stored = storeLaneOutput(directory, {
			batchId,
			laneId,
			agent,
			role,
			sessionId: `${batchId}-sess`,
			parentSessionId: sessionId,
			mode,
			workflowLane: laneId,
			prHeadSha: HEAD_SHA,
			gitHead: HEAD_SHA,
			revisionDigest: REVISION,
			source: 'collect_lane_results',
			text,
		});
		await appendDelegationTransition(directory, batchId, {
			status: 'completed',
			result: {
				text,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				outputRef: stored.ref,
			},
		});
		// `suffix` keeps lane correlation ids distinct across re-arms; the
		// batchId already carries it, so nothing further is needed here.
		void suffix;
	}

	return fixture;
}
