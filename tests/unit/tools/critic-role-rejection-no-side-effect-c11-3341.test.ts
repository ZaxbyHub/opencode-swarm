// Issue #3341 (trace AC11, issue AC1) — a PR_REVIEW dispatch rejected for an
// invalid lane role must not leave durable gate state behind.
//
// Today the dispatch handler activates the PR workflow gate
// (activatePrWorkflow) and binds the review base (bindPrReviewBase) INSIDE the
// mode branch, and only afterwards runs the per-lane role admission loop that
// throws BLOCKED for an invalid role. The rejected batch therefore consumes an
// activated-and-bound workflow that can never launch — the caller cannot retry
// with the same identity. The fix must reject the invalid role BEFORE any
// durable gate activation/binding: readPrWorkflowGateState before and after the
// rejected dispatch must read identically (no PR_REVIEW binding created by the
// rejected call).
//
// Pins (driven through the real executeDispatchLanesAsync entry point over a
// temp git repository with stubbed head/clean/revision/merge-base reads and a
// mocked session-ops client, mirroring
// dispatch-lanes-critic-validator-rejection.test.ts):
//   1. (discriminating) critic phase, agent 'critic_finding_validator':
//      rejected with the invalid-role error AND gate state unchanged.
//   2. (discriminating) reviewer phase, agent 'critic' (a valid canonical
//      role, but not the reviewer phase's required one): same contract.
//
// RED at base, GREEN after the fix.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
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

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-role-no-side-effect-3341-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
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
	restorePrReviewPolicy();
	dispatchInternals.getSessionOps = originalGetSessionOps;
	safeRmRecursive(directory);
});

async function assertRejectedWithoutGateSideEffect(
	args: Record<string, unknown>,
	sessionID: string,
	expectedRejectionText: string,
): Promise<void> {
	const before = await readPrWorkflowGateState(directory, sessionID);
	// Precondition: this fresh session has no gate state yet.
	expect(before).toBe(null);

	const result = await executeDispatchLanesAsync(args, directory, {
		sessionID,
	});
	// The dispatch IS rejected, and by the role-admission rule (so the
	// unchanged-gate assertion below is not satisfied vacuously by some other
	// early failure).
	expect(result.success).toBe(false);
	expect(String(result.message)).toContain(expectedRejectionText);

	const after = await readPrWorkflowGateState(directory, sessionID);
	// The rejected request must not have activated or bound a PR workflow: the
	// durable gate state reads exactly as it did before the call.
	expect(after).toBe(before);
}

describe('invalid-role PR_REVIEW rejection leaves gate state untouched (issue #3341 trace AC11)', () => {
	test("critic phase: 'critic_finding_validator' lane is rejected without activating/binding the gate", async () => {
		await assertRejectedWithoutGateSideEffect(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-lane-3341',
						agent: 'critic_finding_validator',
						prompt: 'Challenge the assigned reviewer verdicts',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			'critic-role-3341-session',
			'uses invalid role',
		);
	});

	test("reviewer phase: a 'critic' agent lane is rejected without activating/binding the gate", async () => {
		await assertRejectedWithoutGateSideEffect(
			{
				mode: 'swarm-pr-review:reviewer',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'reviewer-lane-3341',
						agent: 'critic',
						prompt: 'Re-read every assigned candidate at its exact location.',
						workflow_lane: 'reviewer-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			'reviewer-role-3341-session',
			'uses invalid role',
		);
	});
});
