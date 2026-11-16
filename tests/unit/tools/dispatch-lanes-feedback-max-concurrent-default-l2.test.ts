/**
 * Issue #3315 acceptance check AC19 — ordered PR_FEEDBACK gate dispatch must
 * default an omitted `max_concurrent` to 1.
 * Classification: DISCRIMINATING — RED at base, GREEN after the fix.
 *
 * `src/tools/dispatch-lanes.ts` (base, ~line 2057) rejects every ordered
 * PR_FEEDBACK gate dispatch (stage-b-reviewer / stage-b-test /
 * closeout-reviewer / closeout-critic) unless `max_concurrent` is EXACTLY the
 * number 1:
 *
 * ```ts
 * if (parsed.data.lanes.length !== 1 || parsed.data.max_concurrent !== 1) {
 *   throw new Error(
 *     'BLOCKED: each ordered PR_FEEDBACK gate requires exactly one lane and max_concurrent: 1',
 *   );
 * }
 * ```
 *
 * An omitted `max_concurrent` is `undefined !== 1`, so a correct single-lane
 * dispatch that simply omitted the field is refused even though the lane count
 * is separately enforced to be exactly one — the omission is unambiguous.
 * PR_REVIEW already defaults the field (#2835); E7 aligns PR_FEEDBACK.
 *
 * Post-fix contract: a stage-b-reviewer dispatch with exactly ONE lane and
 * `max_concurrent` OMITTED no longer fails with the ordered-gate message. It
 * may still fail a LATER precondition (this fixture binds the gate without a
 * feedback inventory or tracking branch, so the ladder refuses downstream) —
 * that is acceptable; the discriminating fact is only that the ordered-gate
 * message is gone.
 *
 * Base signature (verified 2026-10-18): the dispatch below returns
 * success:false with exactly
 * "BLOCKED: each ordered PR_FEEDBACK gate requires exactly one lane and max_concurrent: 1".
 *
 * Harness mirrors tests/unit/tools/dispatch-lanes-pr-workflow-gate.test.ts
 * (canonicalMkdtemp fixture + initializeGitRepository + gate/dispatch
 * `_test_exports`/`_internals` head+digest stubs; no mock.module).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

let directory = '';
const originalGetSessionOps = dispatchInternals.getSessionOps;
const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	gateInternals.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	gateInternals.resolveIsWorkingTreeCleanAsync;
const originalResolveRevision =
	dispatchInternals.resolvePrWorkflowRevisionDigest;
const originalResolveRevisionAsync =
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync;
const originalResolveMergeBase = dispatchInternals.resolveExactMergeBase;
const originalResolveMergeBaseAsync =
	dispatchInternals.resolveExactMergeBaseAsync;

const SESSION = 'feedback-max-concurrent-default-3315';

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-feedback-default-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	// Production resolves Git off the blocking spawn (async); route the async
	// twins through the sync stubs so these fixtures drive the async path.
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...args) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...args);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...args) =>
		dispatchInternals.resolveExactMergeBase(...args);
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
	dispatchInternals.resolvePrWorkflowRevisionDigest = originalResolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		originalResolveRevisionAsync;
	dispatchInternals.resolveExactMergeBase = originalResolveMergeBase;
	dispatchInternals.resolveExactMergeBaseAsync = originalResolveMergeBaseAsync;
	dispatchInternals.getSessionOps = originalGetSessionOps;
	safeRmRecursive(directory);
});

describe('ordered PR_FEEDBACK gate dispatch — omitted max_concurrent defaults to 1 (issue #3315 AC19)', () => {
	test('a one-lane stage-b-reviewer dispatch omitting max_concurrent is not refused by the ordered-gate check', async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});

		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:stage-b-reviewer',
				pr_head_sha: 'abc123',
				lanes: [
					{
						id: 'stage-b-review-lane',
						agent: 'reviewer',
						prompt: 'Review the staged fix evidence for FB-001.',
						workflow_lane: 'stage-b-reviewer',
						feedback_item_ids: ['FB-001'],
					},
				],
				// max_concurrent deliberately OMITTED — the single-lane shape makes
				// the omitted value unambiguous (issue #3315 E7).
			},
			directory,
			{ sessionID: SESSION },
		);

		const message = String(result.message ?? '');
		// The discriminating assertion: the ordered-gate refusal must be gone.
		// At base this fails — the message is exactly the ordered-gate refusal.
		expect(
			message,
			`ordered PR_FEEDBACK gate refused an omitted max_concurrent on a valid one-lane dispatch: ${message}`,
		).not.toMatch(
			/each ordered PR_FEEDBACK gate requires exactly one lane and max_concurrent: 1/,
		);
		// The dispatch cannot fully succeed in this fixture (no feedback
		// inventory, no tracked branch), so a later BLOCKED precondition — not
		// the ordered-gate shape error — is the expected outcome at head.
		// Verified at base for the explicit max_concurrent: 1 twin: the later
		// precondition is the tracking-attach refusal from bindPrWorkflowHead.
		expect(result.success).toBe(false);
		expect(message).toMatch(/^BLOCKED: PR_FEEDBACK/);
	});
});
