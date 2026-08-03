import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	assertCurrentCheckoutHead,
	assertPrReviewCleanCheckout,
} from '../../../src/hooks/pr-workflow-gate.js';
import { _internals as dispatchInternals } from '../../../src/tools/dispatch-lanes.js';
import { _internals as stageAInternals } from '../../../src/tools/run-pr-feedback-stage-a.js';

/**
 * Recurrence guardrail for the PR-review dispatch-bind hang (blocking `spawnSync`
 * git on the async host gate path). The gate/dispatch bind path MUST resolve Git
 * through the async spawn helpers — a synchronous, event-loop-blocking spawn on
 * the long-running host (most acutely under Bun on Windows) can hang to its bound
 * and be fail-closed as a spurious "cannot resolve HEAD", killing every lane
 * dispatch. These tests fail if any bind-path checkpoint regresses back to the
 * sync resolver: they route the async seam member to a distinct value and prove
 * the production path reads the async member, never the blocking sync one.
 */
const HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

let syncHeadCalls = 0;
let asyncHeadCalls = 0;
let syncCleanCalls = 0;
let asyncCleanCalls = 0;

beforeEach(() => {
	syncHeadCalls = 0;
	asyncHeadCalls = 0;
	syncCleanCalls = 0;
	asyncCleanCalls = 0;
	// The sync resolvers return the SAME correct answer, so any regression to
	// the blocking path would still pass a value check — only the call counters
	// distinguish the blocking path from the async one.
	_test_exports.resolveCurrentGitHead = () => {
		syncHeadCalls++;
		return HEAD;
	};
	_test_exports.resolveCurrentGitHeadAsync = async () => {
		asyncHeadCalls++;
		return HEAD;
	};
	_test_exports.resolveIsWorkingTreeClean = () => {
		syncCleanCalls++;
		return true;
	};
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => {
		asyncCleanCalls++;
		return true;
	};
});

afterEach(() => {
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
});

describe('PR-workflow bind path resolves Git off the blocking spawn', () => {
	test('assertCurrentCheckoutHead reads the async HEAD resolver, never the sync spawn', async () => {
		const resolved = await assertCurrentCheckoutHead('/nonexistent-dir', HEAD);
		expect(resolved).toBe(HEAD);
		expect(asyncHeadCalls).toBe(1);
		// Regression tripwire: the pre-fix code called the blocking sync resolver.
		expect(syncHeadCalls).toBe(0);
	});

	test('assertPrReviewCleanCheckout reads the async clean-check resolver, never the sync spawn', async () => {
		await assertPrReviewCleanCheckout('/nonexistent-dir');
		expect(asyncCleanCalls).toBe(1);
		expect(syncCleanCalls).toBe(0);
	});

	test('the dispatch bind seam exposes the async HEAD/merge-base/digest resolvers', () => {
		// Prevents silent removal of the async seam members the dispatch bind
		// path (executeDispatchLanesAsync) awaits.
		expect(typeof dispatchInternals.resolveExactMergeBaseAsync).toBe(
			'function',
		);
		expect(typeof dispatchInternals.resolvePrWorkflowRevisionDigestAsync).toBe(
			'function',
		);
	});

	test('the gate seam exposes an async twin for every Git resolver the bind/publish path reads', () => {
		// Prevents any PR-workflow gate/publish checkpoint from regressing back to
		// a blocking sync spawn by silently dropping its async twin. Every twin
		// below is awaited on a fail-closed gate path (bind, publication-arming,
		// completion push-verification, or PR-review base binding).
		for (const twin of [
			'resolveCurrentGitHeadAsync',
			'resolveIsWorkingTreeCleanAsync',
			'resolveCurrentUpstreamPushTargetAsync',
			'resolveRemoteRefsContainingHeadAsync',
			'resolveExactRemoteBranchHeadAsync',
			'resolveCommitCountSinceAsync',
			'resolveIsExactSingleChildCommitAsync',
			'resolvePrReviewDiffStatsAsync',
		] as const) {
			expect(typeof _test_exports[twin]).toBe('function');
		}
	});

	test('the Stage-A runner seam exposes the async twins its integrity monitor awaits', () => {
		// The Stage-A execution monitor re-binds HEAD/control-state/revision-digest
		// between every check; those checkpoints must stay off the blocking spawn.
		expect(typeof stageAInternals.resolveGitControlStateDigestAsync).toBe(
			'function',
		);
		expect(typeof stageAInternals.resolveCurrentGitHeadAsync).toBe('function');
		expect(typeof stageAInternals.resolvePrWorkflowRevisionDigestAsync).toBe(
			'function',
		);
		expect(typeof stageAInternals.resolveExactMergeBaseAsync).toBe('function');
	});
});

/**
 * Call-site regression tripwire (bites where seam-presence checks cannot):
 * every PR-workflow bind/verify/monitor CALL SITE must invoke the async twin,
 * never the blocking synchronous resolver. A source scan catches a reverted
 * call site — e.g. `await resolveCommitCountSinceAsync(...)` mutated back to
 * `resolveCommitCountSince(...)` — which the typeof seam checks and the
 * value-delegating unit fixtures both let through. Mirrors the repo's
 * source-scan guardrail pattern (bundle-portability.test.ts).
 *
 * `resolvePrWorkflowRevisionDigest` (sync) is intentionally excluded: it still
 * has legitimate production call sites (the gate's test-override-detecting
 * `...ForGate` router and write_pr_review_trigger_eval), so its bare form is
 * not a bind-path regression.
 */
describe('no PR-workflow bind path calls a blocking synchronous Git resolver', () => {
	const BIND_PATH_SOURCES = [
		'src/hooks/pr-workflow-gate.ts',
		'src/tools/dispatch-lanes.ts',
		'src/tools/run-pr-feedback-stage-a.ts',
	];
	// Every resolver migrated off the blocking spawn on a bind/verify/monitor
	// path. Each MUST appear only as its `...Async(` twin in the sources above.
	const MUST_BE_ASYNC_ON_BIND_PATH = [
		'resolveCurrentGitHead',
		'resolveIsWorkingTreeClean',
		'resolveExactMergeBase',
		'resolveGitControlStateDigest',
		'resolveCurrentUpstreamPushTarget',
		'resolveCommitCountSince',
		'resolveIsExactSingleChildCommit',
		'resolveRemoteRefsContainingHead',
		'resolveExactRemoteBranchHead',
		'resolvePrReviewDiffStats',
	] as const;

	for (const relativeSource of BIND_PATH_SOURCES) {
		test(`${relativeSource} invokes only the async resolver twins`, () => {
			const source = fs.readFileSync(
				path.resolve(import.meta.dir, '../../..', relativeSource),
				'utf-8',
			);
			for (const resolver of MUST_BE_ASYNC_ON_BIND_PATH) {
				// `.resolveX(` matches the sync call; `.resolveXAsync(` does not
				// (the `(` follows `Async`), so this fires only on a sync call site.
				const syncCallSites = source.match(
					new RegExp(`\\.${resolver}\\(`, 'g'),
				);
				expect(syncCallSites).toBeNull();
			}
		});
	}
});
