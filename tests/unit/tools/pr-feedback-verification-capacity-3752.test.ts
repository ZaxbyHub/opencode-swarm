// Issue #3752 AC1, amendment-at-capacity leg (pulled into PR #3751 by the
// user's option-b instruction), split from the 3644 verification suite for the
// FR-006 500-line cap: a stateful rejection that fires AFTER the capacity
// prune must leave NOTHING durable — no amendment, no prune, no
// retired-ownership growth, no verification record. At base (abd68f19d) the
// amendment persists before the rejection, so the state comparison fails on
// the inventory diff (RED for the reported reason); post-fix nothing lands.
//
// Harness: identical to the 3644 verification suite (real
// executeDispatchLanesAsync over a temp git repo with stubbed gate reads and
// mocked session ops) plus the transport-binding coverage-seed pattern.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { storeLaneOutput } from '../../../src/background/lane-output-store.js';
import {
	appendDelegationTransition,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import {
	activatePrWorkflow,
	declarePrFeedbackInventory,
	enforcePrFeedbackVerificationOwnership,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import {
	installLegacyPrReviewPolicy,
	restorePrReviewPolicy,
} from './dispatch-lanes-pr-workflow-gate.test-fixtures.js';

let directory = '';
const originalGetSessionOps = dispatchInternals.getSessionOps;
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
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalUpstream = gateInternals.resolveCurrentUpstreamPushTarget;
const originalUpstreamAsync =
	gateInternals.resolveCurrentUpstreamPushTargetAsync;
const originalRemoteRefs = gateInternals.resolveRemoteRefsContainingHead;
const originalRemoteRefsAsync =
	gateInternals.resolveRemoteRefsContainingHeadAsync;
const originalDigest = gateInternals.resolvePrWorkflowRevisionDigest;

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-feedback-capacity-3752-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async () =>
		gateInternals.resolveCurrentUpstreamPushTarget();
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async () =>
		gateInternals.resolveRemoteRefsContainingHead();
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		'revision-1';
	installLegacyPrReviewPolicy();
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({ data: { id: 'lane-session' } })),
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
	gateInternals.resolvePrReviewDiffStats = originalResolveDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = originalResolveDiffStatsAsync;
	gateInternals.resolveCurrentUpstreamPushTarget = originalUpstream;
	gateInternals.resolveCurrentUpstreamPushTargetAsync = originalUpstreamAsync;
	gateInternals.resolveRemoteRefsContainingHead = originalRemoteRefs;
	gateInternals.resolveRemoteRefsContainingHeadAsync = originalRemoteRefsAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalDigest;
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	restorePrReviewPolicy();
	dispatchInternals.getSessionOps = originalGetSessionOps;
	safeRmRecursive(directory);
});

describe('PR_FEEDBACK verification amendment-at-capacity wedge (issue #3752 AC1)', () => {
	test('W2: an amendment-at-capacity dispatch rejected for post-prune exclusivity consumes no state', async () => {
		// Fill prFeedbackVerifications to the production cap (via the exported
		// test constant, so the seed stays aligned if the cap changes) with
		// PRUNABLE inert batches (no artifacts -> zero coverage) plus one
		// covered newest batch, then dispatch an amended inventory re-claiming
		// the covered item under a different lane id: the capacity prune
		// reclaims room, and the post-prune exclusivity check rejects. Assert
		// the GATE error is 'owned by both' (explicitly NOT 'batch limit
		// reached'), and that NOTHING persisted.
		const session = 'wedge-capacity-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declarePrFeedbackInventory(directory, session, ['FB-001'], {
			prHeadSha: 'abc123',
		});
		const MAX_BATCHES: number = gateInternals.MAX_WORKFLOW_BATCHES;
		expect(MAX_BATCHES).toBeGreaterThan(1);
		for (let i = 0; i < MAX_BATCHES - 1; i += 1) {
			await enforcePrFeedbackVerificationOwnership(
				directory,
				session,
				[{ laneId: `inert-lane-${i}`, ownedItemIds: ['FB-001'] }],
				{ batchId: `inert-batch-${i}`, prHeadSha: 'abc123' },
			);
		}
		const coveredBatch = `covered-batch-${MAX_BATCHES}`;
		await enforcePrFeedbackVerificationOwnership(
			directory,
			session,
			[{ laneId: 'covered-lane', ownedItemIds: ['FB-001'] }],
			{ batchId: coveredBatch, prHeadSha: 'abc123' },
		);
		const correlationId = `${coveredBatch}--covered-lane`;
		await recordPendingDelegation(directory, {
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: session,
			callID: coveredBatch,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			batchId: coveredBatch,
			laneId: 'covered-lane',
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'covered-lane',
			workspace: {
				directory,
				gitHead: 'abc123',
				dirtyHash: 'revision-1',
				prHeadSha: 'abc123',
				scope: null,
			},
			promptHash: 'covered-hash',
			generation: 1,
		});
		const coveredText =
			'[FEEDBACK-VERIFIED] | FB-001 | CONFIRMED | evidence FB-001';
		const stored = storeLaneOutput(directory, {
			batchId: coveredBatch,
			laneId: 'covered-lane',
			agent: 'reviewer',
			role: 'reviewer',
			sessionId: correlationId,
			parentSessionId: session,
			mode: 'swarm-pr-feedback:verification',
			workflowLane: 'covered-lane',
			prHeadSha: 'abc123',
			gitHead: 'abc123',
			revisionDigest: 'revision-1',
			source: 'collect_lane_results',
			text: coveredText,
		});
		await appendDelegationTransition(directory, correlationId, {
			status: 'completed',
			result: {
				text: coveredText,
				chars: stored.chars,
				truncated: false,
				digest: stored.digest,
				outputRef: stored.ref,
			},
		});
		const before = await readPrWorkflowGateState(directory, session);
		expect(before?.prFeedbackVerifications?.length).toBe(MAX_BATCHES);
		const wedged = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				batch_id: 'wedge-capacity-batch',
				feedback_inventory: ['FB-001', 'FB-00X'],
				lanes: [
					{
						id: 'wedge-capacity-lane',
						agent: 'reviewer',
						prompt: 'Re-verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(wedged.success).toBe(false);
		const message = String(wedged.message);
		expect(message).toContain('owned by both');
		expect(message).not.toContain('verification batch limit reached');
		// Nothing persisted: no amendment, no prune, no retired-ownership
		// growth, no new record (at base the amendment persisted first).
		const after = await readPrWorkflowGateState(directory, session);
		expect(after?.prFeedbackInventory).toEqual(['FB-001']);
		expect(after?.prFeedbackVerifications?.length).toBe(MAX_BATCHES);
		expect(after?.prFeedbackRetiredItemOwnership ?? {}).toEqual(
			before?.prFeedbackRetiredItemOwnership ?? {},
		);
	}, 120_000);
});
