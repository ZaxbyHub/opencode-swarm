// Issue #3644 AC1 — a rejected swarm-pr-feedback:verification dispatch must
// consume NO inventory state. At base (verified on this branch's base
// abd68f19d2) the dispatch path in src/tools/dispatch-lanes.ts calls
// declarePrFeedbackInventory BEFORE enforcePrFeedbackVerificationOwnership, so
// a request whose inventory is typo'd (e.g. feedback_inventory ['FB-00X'] with
// a lane owning ['FB-001']) is rejected for "owns undeclared item" only AFTER
// the typo'd inventory has been persisted. The inventory is append-only, so a
// corrected retry that drops 'FB-00X' is then blocked ("may not be removed or
// renamed") — the session is wedged by its own rejected request.
//
// Classification: tests 1 and 2 are DISCRIMINATING (RED at base — the fix must
// reject the request before any inventory persistence); test 3 is PRESERVING
// (GREEN at base — a well-formed first dispatch still succeeds and persists
// its inventory).
//
// Harness: copied wholesale from
// tests/unit/tools/dispatch-lanes-state-free-admission-3341.test.ts (real
// executeDispatchLanesAsync over a real temp git repository with stubbed
// head/clean/diffstats gate reads, stubbed revision/mergebase dispatch reads,
// installLegacyPrReviewPolicy, and a mocked session ops client). ONE minimal
// adaptation, required because these legs drive the PR_FEEDBACK verification
// bind deeper than the #3341 legs did: declarePrFeedbackInventory →
// bindPrWorkflowHead → assertPrFeedbackTrackingCheckout refuses on a
// commit-less fixture repo (no upstream, no refs containing the head), and
// enforcePrFeedbackVerificationOwnership → currentPrFeedbackRevisionDigest
// runs the gate's real bounded git digest. This file additionally stubs the
// gate _test_exports seams the canonical hooks fixtures
// (tests/unit/hooks/pr-workflow-gate.test-fixtures.ts) already stub for every
// PR_FEEDBACK test: resolveCurrentUpstreamPushTarget(Async),
// resolveRemoteRefsContainingHead(Async), and
// resolvePrWorkflowRevisionDigest. No mock.module anywhere.
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
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;
// PR_FEEDBACK tracking-attach and gate-digest seams (see header note).
const originalResolveUpstream = gateInternals.resolveCurrentUpstreamPushTarget;
const originalResolveUpstreamAsync =
	gateInternals.resolveCurrentUpstreamPushTargetAsync;
const originalResolveRemoteRefs = gateInternals.resolveRemoteRefsContainingHead;
const originalResolveRemoteRefsAsync =
	gateInternals.resolveRemoteRefsContainingHeadAsync;
const originalGateResolveRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-feedback-verify-3644-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (...a) =>
		gateInternals.resolvePrReviewDiffStats(...a);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...a);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...a) =>
		dispatchInternals.resolveExactMergeBase(...a);
	// Give the PR_FEEDBACK tracking attach the canonical fixture shape: one
	// upstream push target whose remote-tracking ref contains the intake head,
	// so assertPrFeedbackTrackingCheckout returns on its verified-upstream path
	// instead of refusing the commit-less fixture repo.
	gateInternals.resolveCurrentUpstreamPushTarget = () => ({
		remoteName: 'origin',
		remoteBranchRef: 'refs/heads/pr-head',
		remoteTrackingRef: 'refs/remotes/origin/pr-head',
	});
	gateInternals.resolveCurrentUpstreamPushTargetAsync = async (dir) =>
		gateInternals.resolveCurrentUpstreamPushTarget(dir);
	gateInternals.resolveRemoteRefsContainingHead = () => [
		'refs/remotes/origin/pr-head',
	];
	gateInternals.resolveRemoteRefsContainingHeadAsync = async (dir, head) =>
		gateInternals.resolveRemoteRefsContainingHead(dir, head);
	// The gate's own digest resolution (currentPrFeedbackRevisionDigest inside
	// enforcePrFeedbackVerificationOwnership) runs real bounded git otherwise.
	gateInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
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
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	gateInternals.resolveCurrentUpstreamPushTarget = originalResolveUpstream;
	gateInternals.resolveCurrentUpstreamPushTargetAsync =
		originalResolveUpstreamAsync;
	gateInternals.resolveRemoteRefsContainingHead = originalResolveRemoteRefs;
	gateInternals.resolveRemoteRefsContainingHeadAsync =
		originalResolveRemoteRefsAsync;
	gateInternals.resolvePrWorkflowRevisionDigest =
		originalGateResolveRevisionDigest;
	restorePrReviewPolicy();
	dispatchInternals.getSessionOps = originalGetSessionOps;
	safeRmRecursive(directory);
});

describe('PR_FEEDBACK verification rejection consumes no inventory state (issue #3644 AC1)', () => {
	test('a typo inventory rejected for owning an undeclared item leaves the gate state unchanged', async () => {
		const session = 'verify-typo-3644';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-00X'],
				lanes: [
					{
						id: 'verify-typo-lane-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('owns undeclared item');
		// The rejected request must leave the gate state — including the
		// feedback inventory — exactly as the pre-dispatch snapshot.
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
	}, 60_000);

	test('a corrected retry after a rejected typo inventory succeeds on the same session', async () => {
		const session = 'verify-retry-3644';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		// Batch A: the typo'd request — rejected for owning an undeclared
		// item. At base this rejection happens AFTER the typo'd inventory
		// was persisted, which is exactly what wedges batch B below.
		const typo = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-00X'],
				lanes: [
					{
						id: 'verify-retry-typo-lane-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(typo.success).toBe(false);
		expect(String(typo.message)).toContain('owns undeclared item');
		// Batch B: the corrected retry drops the typo and declares exactly
		// the item the lane owns, under a fresh lane id (no batch id field —
		// the async schema generates its own). The mocked session ops let
		// the launch proceed, so this must succeed once the rejected batch A
		// no longer persists its inventory.
		const corrected = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-001'],
				lanes: [
					{
						id: 'verify-retry-corrected-lane-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(corrected.success).toBe(true);
	}, 60_000);

	test('a well-formed first verification dispatch succeeds and persists the declared inventory', async () => {
		// Preserving leg (GREEN at base): the statelessness contract only
		// covers REJECTED requests — an admitted dispatch still declares and
		// persists its inventory.
		const session = 'verify-wellformed-3644';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-001'],
				lanes: [
					{
						id: 'verify-wellformed-lane-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(true);
		const state = await readPrWorkflowGateState(directory, session);
		expect(state?.prFeedbackInventory).toEqual(['FB-001']);
	}, 60_000);

	test('a typo inventory rejected on a FRESH session activates no PR_FEEDBACK workflow', async () => {
		// Discriminating leg (RED at base): with no pre-existing gate the
		// dispatch itself activates PR_FEEDBACK before declaring the typo'd
		// inventory and rejecting the lane — the rejected request must
		// instead leave NO gate state at all.
		const session = 'verify-fresh-typo-3644';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-00X'],
				lanes: [
					{
						id: 'verify-fresh-typo-lane-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('owns undeclared item');
		expect(await readPrWorkflowGateState(directory, session)).toBeNull();
	}, 60_000);

	test('an in-request duplicate ownership rejection consumes no inventory state', async () => {
		// Discriminating leg (RED at base): two lanes in one request both
		// owning FB-001 must be rejected by the exclusivity check
		// ("owned by both") WITHOUT the declared inventory being persisted.
		const session = 'verify-duplicate-3644';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const before = await readPrWorkflowGateState(directory, session);
		expect(before).not.toBeNull();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-001', 'FB-002'],
				lanes: [
					{
						id: 'verify-duplicate-lane-a-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
					{
						id: 'verify-duplicate-lane-b-3644',
						agent: 'reviewer',
						prompt: 'Verify FB-001 again.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-001'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain('owned by both');
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
	}, 60_000);

	test('W1 (#3752 AC1): a duplicate-batch rejection after an inventory amendment consumes no state and the corrected retry succeeds', async () => {
		// Discriminating leg (RED at base). Batch A is seeded via DIRECT gate
		// calls (no delegation-store row for A, so the dispatch-level
		// batch-uniqueness guard passes and the GATE duplicate rejection is the
		// one that fires). The amended dispatch reuses batch id A: at base the
		// amendment persists before the rejection (state diff) and the corrected
		// retry is then blocked by the append-only rule; post-fix neither write
		// lands and the retry succeeds.
		const session = 'wedge-duplicate-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declarePrFeedbackInventory(directory, session, ['FB-001'], {
			prHeadSha: 'abc123',
		});
		await enforcePrFeedbackVerificationOwnership(
			directory,
			session,
			[{ laneId: 'wedge-lane-a', ownedItemIds: ['FB-001'] }],
			{ batchId: 'wedge-batch-a', prHeadSha: 'abc123' },
		);
		const before = await readPrWorkflowGateState(directory, session);
		expect(before?.prFeedbackInventory).toEqual(['FB-001']);
		const amended = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				batch_id: 'wedge-batch-a',
				feedback_inventory: ['FB-001', 'FB-00X'],
				lanes: [
					{
						id: 'wedge-lane-b',
						agent: 'reviewer',
						prompt: 'Verify FB-00X.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-00X'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(amended.success).toBe(false);
		expect(String(amended.message)).toContain(
			'verification batch id "wedge-batch-a" is already recorded',
		);
		expect(String(amended.message)).not.toContain('batch already exists');
		// Discriminator: the rejected amended request leaves the gate state
		// byte-for-byte unchanged (at base the amendment persisted first).
		expect(await readPrWorkflowGateState(directory, session)).toEqual(before);
		// Corrected retry on a fresh batch id succeeds (at base it is blocked
		// by the append-only rule because FB-00X became durable).
		const corrected = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				batch_id: 'wedge-batch-c',
				feedback_inventory: ['FB-001'],
				lanes: [
					{
						id: 'wedge-lane-a',
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
		expect(corrected.success).toBe(true);
	}, 60_000);

	test('W3 (#3752 AC1): preserving — a valid amended dispatch persists both the amendment and the verification record', async () => {
		const session = 'amend-success-3752';
		await activatePrWorkflow(directory, session, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		await declarePrFeedbackInventory(directory, session, ['FB-001'], {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				batch_id: 'amend-success-batch',
				feedback_inventory: ['FB-001', 'FB-002'],
				lanes: [
					{
						id: 'amend-success-lane',
						agent: 'reviewer',
						prompt: 'Verify FB-002.',
						workflow_lane: 'verification',
						feedback_item_ids: ['FB-002'],
					},
				],
			},
			directory,
			{ sessionID: session },
		);
		expect(result.success).toBe(true);
		const state = await readPrWorkflowGateState(directory, session);
		expect(state?.prFeedbackInventory).toEqual(['FB-001', 'FB-002']);
		expect(
			state?.prFeedbackInventoryAmendments?.some(
				(amendment) => amendment.entry === 'FB-002',
			),
		).toBe(true);
		expect(
			state?.prFeedbackVerifications?.some(
				(record) => record.batchId === 'amend-success-batch',
			),
		).toBe(true);
	}, 60_000);
});
