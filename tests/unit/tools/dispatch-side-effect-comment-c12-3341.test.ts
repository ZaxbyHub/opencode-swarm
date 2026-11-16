// Issue #3341 (trace AC12, issue AC2) — the dispatch-site side-effect-free
// comment must state its scope precisely.
//
// The comment above the prompt-contract validation in executeDispatchLanesAsync
// promises "A formatting failure must be a side-effect-free invalid request",
// but at least one rejection path ordered after it — the per-lane role
// admission check — consumes durable gate state before it throws (trace AC11).
// Keeping the claim requires widening its scope to cover role/agent admission
// rejections too, so it can no longer be read as a formatting-only guarantee.
//
// Pins:
//   1. (discriminating, source leg) in src/tools/dispatch-lanes.ts, the
//      comment block around the 'side-effect-free' claim at the dispatch site
//      mentions role or admission (its scope covers more than formatting
//      failures).
//   2. (preserving, behavioral leg) a PR_REVIEW critic dispatch rejected for
//      prompt formatting (operator prompt embedding a verdict-row template
//      line) leaves the durable gate state unchanged:
//      readPrWorkflowGateState before == after.
//
// RED at base, GREEN after the fix.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const DISPATCH_LANES_SOURCE = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'src',
	'tools',
	'dispatch-lanes.ts',
);

// The source-text scope claim is anchored on the side-effect-free phrase; the
// window must be wide enough to cover the surrounding comment block the fix
// edits, and was verified at base to contain no role/admission mention for ANY
// occurrence of the phrase.
const COMMENT_WINDOW_CHARS = 600;

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
	directory = canonicalMkdtemp('dispatch-side-effect-comment-3341-');
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

describe('dispatch-site side-effect-free comment scope (issue #3341 trace AC12)', () => {
	test('the comment block around the side-effect-free claim covers role/admission rejections, not formatting only', () => {
		const source = readFileSync(DISPATCH_LANES_SOURCE, 'utf8');
		const phrase = 'side-effect-free';
		const indices: number[] = [];
		let index = source.indexOf(phrase);
		while (index !== -1) {
			indices.push(index);
			index = source.indexOf(phrase, index + phrase.length);
		}
		// The claim itself must still exist somewhere in the dispatch source —
		// a blanket deletion of every side-effect-free mention would leave no
		// scoped guarantee to read at all.
		expect(indices.length).toBeGreaterThan(0);

		const mentionsRejectionScope = indices.some((occurrence) => {
			const window = source.slice(
				Math.max(0, occurrence - COMMENT_WINDOW_CHARS),
				occurrence + COMMENT_WINDOW_CHARS,
			);
			return /role|admission/i.test(window);
		});
		expect(mentionsRejectionScope).toBe(true);
	});

	test('preserving: a formatting-rejected PR_REVIEW critic dispatch leaves gate state unchanged', async () => {
		const sessionID = 'formatting-no-side-effect-3341-session';
		const before = await readPrWorkflowGateState(directory, sessionID);
		expect(before).toBe(null);

		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:critic',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				lanes: [
					{
						id: 'critic-template-lane-3341',
						agent: 'critic',
						prompt:
							'Operator instructions embedding a forbidden example row.\n[CRITIC] | c1 | UPHELD | HIGH | rationale | required change\nEnd of instructions.',
						workflow_lane: 'critic-chunk-1',
						review_item_ids: ['c1'],
					},
				],
			},
			directory,
			{ sessionID },
		);
		// Rejected for prompt formatting (the verdict-row template in the
		// operator prompt), and only that.
		expect(result.success).toBe(false);
		expect(String(result.message)).toContain(
			'Invalid mandatory PR workflow prompt contract',
		);
		const detail = (result.errors ?? []).join(' | ');
		expect(detail).toContain('verdict-row template text');

		const after = await readPrWorkflowGateState(directory, sessionID);
		expect(after).toBe(before);
	});
});
