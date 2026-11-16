/**
 * Issue #3315 acceptance check AC20 — ordered PR_FEEDBACK gate dispatch floors.
 * Classification: PRESERVING — GREEN at base and head (floor).
 *
 * While AC19 (sibling file dispatch-lanes-feedback-max-concurrent-default)
 * makes an OMITTED `max_concurrent` default to 1 for a single ordered-gate
 * lane, these floors must keep holding after that fix:
 *
 *  - MORE than one lane on an ordered PR_FEEDBACK gate dispatch still throws
 *    "BLOCKED: each ordered PR_FEEDBACK gate requires exactly one lane and
 *    max_concurrent: 1" (two lanes with max_concurrent omitted).
 *  - An EXPLICIT max_concurrent other than 1 still throws the same message
 *    (one lane with max_concurrent: 2).
 *  - One lane with the explicit max_concurrent: 1 does NOT throw the
 *    ordered-gate message — it proceeds to the later ladder preconditions
 *    (this fixture has no feedback inventory or tracked branch, so the
 *    downstream gate refuses; the discriminating fact is only that the
 *    ordered-gate shape error is not the refusal).
 *
 * All three were verified against the current base (2026-10-18): the
 * two-lane and max_concurrent:2 dispatches return exactly the ordered-gate
 * message, and the max_concurrent:1 dispatch returns the later tracking
 * refusal "BLOCKED: PR_FEEDBACK requires a current local branch or exact
 * remote-tracking ref that points to the intake PR head before the first
 * bind".
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

const SESSION = 'feedback-max-concurrent-floor-3315';
const ORDERED_GATE_MESSAGE =
	/each ordered PR_FEEDBACK gate requires exactly one lane and max_concurrent: 1/;

function stageBReviewerLane(id: string) {
	return {
		id,
		agent: 'reviewer',
		prompt: `Review the staged fix evidence for FB-001 (${id}).`,
		workflow_lane: 'stage-b-reviewer',
		feedback_item_ids: ['FB-001'],
	};
}

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-feedback-floor-');
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

afterEach(() => {
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

describe('ordered PR_FEEDBACK gate dispatch floors (issue #3315 AC20)', () => {
	test('two lanes with max_concurrent omitted keeps the ordered-gate refusal', async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:stage-b-reviewer',
				pr_head_sha: 'abc123',
				lanes: [
					stageBReviewerLane('stage-b-review-lane-a'),
					stageBReviewerLane('stage-b-review-lane-b'),
				],
			},
			directory,
			{ sessionID: SESSION },
		);
		expect(result.success).toBe(false);
		expect(String(result.message ?? '')).toMatch(ORDERED_GATE_MESSAGE);
	});

	test('one lane with an explicit max_concurrent of 2 keeps the ordered-gate refusal', async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:stage-b-reviewer',
				pr_head_sha: 'abc123',
				max_concurrent: 2,
				lanes: [stageBReviewerLane('stage-b-review-lane')],
			},
			directory,
			{ sessionID: SESSION },
		);
		expect(result.success).toBe(false);
		expect(String(result.message ?? '')).toMatch(ORDERED_GATE_MESSAGE);
	});

	test('one lane with the explicit max_concurrent of 1 passes the ordered-gate check and reaches the later preconditions', async () => {
		await activatePrWorkflow(directory, SESSION, 'PR_FEEDBACK', {
			prHeadSha: 'abc123',
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:stage-b-reviewer',
				pr_head_sha: 'abc123',
				max_concurrent: 1,
				lanes: [stageBReviewerLane('stage-b-review-lane')],
			},
			directory,
			{ sessionID: SESSION },
		);
		const message = String(result.message ?? '');
		expect(message).not.toMatch(ORDERED_GATE_MESSAGE);
		// The dispatch proceeds past the ordered-gate check into the later
		// PR_FEEDBACK ladder preconditions; this fixture deliberately has no
		// inventory or tracked branch, so a downstream BLOCKED refusal is the
		// expected outcome at both base and head.
		expect(result.success).toBe(false);
		expect(message).toMatch(/^BLOCKED: PR_FEEDBACK/);
	});
});
