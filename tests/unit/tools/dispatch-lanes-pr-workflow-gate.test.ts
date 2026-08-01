import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	computePrReviewDepthTier,
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	dispatch_lanes_async,
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
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
const originalResolveDiffStats = gateInternals.resolvePrReviewDiffStats;
const originalResolveDiffStatsAsync =
	gateInternals.resolvePrReviewDiffStatsAsync;

function lane(
	id: string,
	workflowLane?: string,
	feedbackItemIds?: string[],
	ownedWorkflowLanes?: string[],
) {
	return {
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		...(workflowLane ? { workflow_lane: workflowLane } : {}),
		...(feedbackItemIds ? { feedback_item_ids: feedbackItemIds } : {}),
		...(ownedWorkflowLanes ? { owned_workflow_lanes: ownedWorkflowLanes } : {}),
	};
}

function uniqueSessionOps() {
	let sessionIndex = 0;
	dispatchInternals.getSessionOps = () => ({
		create: mock(async () => ({
			data: { id: `tier-lane-session-${sessionIndex++}` },
		})),
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
}

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'dispatch-pr-gate-')),
	);
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
	gateInternals.resolvePrReviewDiffStatsAsync = async (...a) =>
		gateInternals.resolvePrReviewDiffStats(...a);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async (...a) =>
		dispatchInternals.resolvePrWorkflowRevisionDigest(...a);
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async (...a) =>
		dispatchInternals.resolveExactMergeBase(...a);
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
	dispatchInternals.getSessionOps = originalGetSessionOps;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('dispatch_lanes PR workflow enforcement', () => {
	test('supports a read-only test_engineer validation lane', async () => {
		const result = await executeDispatchLanesAsync(
			{
				lanes: [
					{
						id: 'test-validation',
						agent: 'test_engineer',
						prompt:
							'Run independent falsification probes without editing files',
					},
				],
			},
			directory,
			{ sessionID: 'ordinary-session' },
		);
		expect(result.success).toBe(true);
		expect(result.pending).toBe(1);
	});

	test('blocks a two-of-six PR review base wave and names the six obligations', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: [
					lane('lane-a', 'intent-architecture'),
					lane('lane-b', 'correctness-state'),
				],
			},
			directory,
			{ sessionID: 'review-session' },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('exactly six lanes');
	});

	// --- actionable merge-base diagnostics -------------------------------
	//
	// Field evidence: a capable model burned four `dispatch_lanes_async` calls
	// brute-forcing the `base_ref` spelling for ONE dispatch. It passed the same
	// correct merge base every time; `refs/heads/main` and `main` were rejected,
	// `origin/main` accepted. The old rejection string named neither the value it
	// computed nor the one it received, and collapsed "ref did not resolve" and
	// "SHA mismatch" into a single sentence — so trial and error was the only
	// available recovery. These tests pin the receipt.

	test('a merge-base MISMATCH names the computed value, the received value, and the stale-local-ref cause', async () => {
		dispatchInternals.resolveExactMergeBase = () => 'def456';
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				// Correct merge base, but named via a LOCAL ref — the exact shape
				// that produced the field failure.
				base_sha: 'aaaa11',
				base_ref: 'refs/heads/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`base-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'mismatch-diagnostic-session' },
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		// The receipt: what was computed, and what was passed.
		expect(message).toContain('def456');
		expect(message).toContain('aaaa11');
		expect(message).toContain('refs/heads/main');
		// The actual cause, named rather than left to be guessed.
		expect(message).toContain('remote-tracking');
		expect(message).toContain('may be stale');
		// A command the caller can run to see it for themselves.
		expect(message).toContain('git -C');
		expect(message).toContain('merge-base');
	});

	test('an UNRESOLVABLE base_ref is reported as a ref-resolution failure, not as a wrong base_sha', async () => {
		// Distinct failure: the ref never resolved at all. Previously this
		// produced the same "base_sha is not the exact merge base" string, telling
		// a caller their SHA was wrong when it may have been perfectly correct.
		dispatchInternals.resolveExactMergeBase = () => null;
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/does-not-exist',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`base-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'unresolvable-ref-session' },
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).toContain('could not resolve a merge base');
		expect(message).toContain('origin/does-not-exist');
		// Names the preflight gap that causes it.
		expect(message).toContain('refs/pull/');
		// Must NOT blame the caller's base_sha.
		expect(message).not.toContain('is not the exact merge base');
	});

	test('a bare colon-less PR workflow mode is rejected by name instead of misrouting into a merge-base error', async () => {
		const result = await executeDispatchLanesAsync(
			{
				// The value the old `mode` description literally advertised.
				mode: 'swarm-pr-review',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`base-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'bare-mode-session' },
		);
		expect(result.success).toBe(false);
		const message = String(result.message);
		expect(message).toContain('missing its required stage suffix');
		expect(message).toContain('swarm-pr-review:base');
		// The old failure mode: blaming the merge base for a mode typo.
		expect(message).not.toContain('merge-base scope was not verified');
	});

	test('surrounding whitespace on mode cannot silently skip the merge-base bind', async () => {
		// Roughly twenty sites branch on `mode` with startsWith/strict equality.
		// Before normalization, " swarm-pr-review:base" failed every
		// startsWith('swarm-pr-review:') check, skipped the merge-base bind
		// entirely, and surfaced much later as "exact merge-base scope was not
		// verified" — the merge base blamed for a whitespace typo. This is the
		// same near-miss family as the bare colon-less mode above, so it must be
		// closed by normalization rather than by one more literal comparison.
		let sessionIndex = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({
				data: { id: `ws-lane-session-${sessionIndex++}` },
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		// Leading whitespace: must behave exactly like the clean value, i.e. bind
		// the merge base and dispatch successfully.
		const leading = await executeDispatchLanesAsync(
			{
				mode: ' swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`ws-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'whitespace-leading-session' },
		);
		expect(leading.success).toBe(true);

		// Trailing whitespace previously passed the bind but failed the strict
		// equality that records the base batch.
		const trailing = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base ',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`ws2-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'whitespace-trailing-session' },
		);
		expect(trailing.success).toBe(true);

		// A padded BARE mode still hits the named stage-suffix rejection rather
		// than slipping through as an unrecognized advisory tag.
		const paddedBare = await executeDispatchLanesAsync(
			{
				mode: '  swarm-pr-review  ',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`ws3-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'whitespace-bare-session' },
		);
		expect(paddedBare.success).toBe(false);
		expect(String(paddedBare.message)).toContain(
			'missing its required stage suffix',
		);
	});

	test('the PR-gating parameters document the remote-tracking requirement and the colon-suffixed modes', () => {
		const describe_ = (field: unknown): string =>
			String((field as { description?: string })?.description ?? '');
		// base_ref is where the field failure happened — the description must
		// name the remote-tracking form and why a local ref differs.
		const baseRef = describe_(dispatch_lanes_async.args.base_ref);
		expect(baseRef).toContain('origin/main');
		expect(baseRef.toLowerCase()).toContain('remote-tracking');
		// base_sha must distinguish merge base from base-branch tip.
		expect(describe_(dispatch_lanes_async.args.base_sha)).toContain(
			'merge base',
		);
		// pr_head_sha must exist as a documented field at all.
		expect(
			describe_(dispatch_lanes_async.args.pr_head_sha).length,
		).toBeGreaterThan(0);
		// mode must enumerate the colon-suffixed stages.
		const mode = describe_(dispatch_lanes_async.args.mode);
		expect(mode).toContain('swarm-pr-review:base');
		expect(mode).toContain('swarm-pr-review:reviewer');
		expect(mode).toContain('swarm-pr-feedback:verification');
	});

	test('binds the first exact merge base and rejects later scope drift', async () => {
		let sessionIndex = 0;
		dispatchInternals.getSessionOps = () => ({
			create: mock(async () => ({
				data: { id: `base-lane-session-${sessionIndex++}` },
			})),
			promptAsync: mock(async () => ({ data: undefined, error: undefined })),
			delete: mock(async () => undefined),
		});
		const initial = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`base-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'base-binding-session' },
		);
		expect(initial.success).toBe(true);

		dispatchInternals.resolveExactMergeBase = () => 'feed00';
		const drifted = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'feed00',
				base_ref: 'origin/rebased-main',
				max_concurrent: 1,
				lanes: [lane('retry-intent', PR_REVIEW_BASE_DIMENSION_IDS[0])],
			},
			directory,
			{ sessionID: 'base-binding-session' },
		);
		expect(drifted.success).toBe(false);
		expect(drifted.message).toContain('bound to merge-base scope');
	});

	test('computePrReviewDepthTier maps sizes and fails strict to L on unknown stats', () => {
		expect(computePrReviewDepthTier(null)).toBe('L');
		expect(computePrReviewDepthTier(undefined)).toBe('L');
		expect(
			computePrReviewDepthTier({ changedLines: 10, changedFiles: 2 }),
		).toBe('S');
		expect(
			computePrReviewDepthTier({ changedLines: 50, changedFiles: 3 }),
		).toBe('S');
		expect(
			computePrReviewDepthTier({ changedLines: 51, changedFiles: 3 }),
		).toBe('M');
		expect(
			computePrReviewDepthTier({ changedLines: 20, changedFiles: 4 }),
		).toBe('M');
		expect(
			computePrReviewDepthTier({ changedLines: 500, changedFiles: 20 }),
		).toBe('M');
		expect(
			computePrReviewDepthTier({ changedLines: 501, changedFiles: 2 }),
		).toBe('L');
	});

	test('computePrReviewDepthTier escalates to L on file-count overflow or a submodule change, closing the file-count blind spot', () => {
		// A many-small-files diff (e.g. a wide binary/generated-file sweep, or a
		// mechanical multi-file rename) must not stay at tier M purely because
		// its aggregate changed-line count is small: file count now has its own
		// ceiling, mirroring the S-tier check.
		expect(
			computePrReviewDepthTier({ changedLines: 500, changedFiles: 21 }),
		).toBe('L');
		expect(
			computePrReviewDepthTier({ changedLines: 0, changedFiles: 200 }),
		).toBe('L');
		// A submodule pointer bump reports as a fixed tiny numstat delta
		// regardless of the referenced repository's real diff size, so it must
		// escalate unconditionally, independent of both thresholds.
		expect(
			computePrReviewDepthTier({
				changedLines: 2,
				changedFiles: 1,
				hasSubmoduleChange: true,
			}),
		).toBe('L');
		expect(
			computePrReviewDepthTier({
				changedLines: 2,
				changedFiles: 1,
				hasSubmoduleChange: false,
			}),
		).toBe('S');
	});

	test('accepts a consolidated two-lane initial base wave at depth tier S', async () => {
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 12,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		uniqueSessionOps();
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 2,
				lanes: [
					lane('sweep-a', PR_REVIEW_BASE_DIMENSION_IDS[0], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3),
					]),
					lane('sweep-b', PR_REVIEW_BASE_DIMENSION_IDS[3], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(3),
					]),
				],
			},
			directory,
			{ sessionID: 'tier-s-session' },
		);
		expect(result.success).toBe(true);
		expect(result.pending).toBe(2);
	});

	test('rejects a tier-S consolidated wave whose ownership misses a dimension', async () => {
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 12,
			changedFiles: 2,
			hasSubmoduleChange: false,
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 2,
				lanes: [
					lane('sweep-a', PR_REVIEW_BASE_DIMENSION_IDS[0], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3),
					]),
					lane('sweep-b', PR_REVIEW_BASE_DIMENSION_IDS[3], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(3, 5),
					]),
				],
			},
			directory,
			{ sessionID: 'tier-s-missing-session' },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'partition all six dimensions exactly once',
		);
	});

	test('rejects consolidated ownership on the initial base wave at depth tier L', async () => {
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 4_000,
			changedFiles: 60,
			hasSubmoduleChange: false,
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 2,
				lanes: [
					lane('sweep-a', PR_REVIEW_BASE_DIMENSION_IDS[0], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3),
					]),
					lane('sweep-b', PR_REVIEW_BASE_DIMENSION_IDS[3], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(3),
					]),
				],
			},
			directory,
			{ sessionID: 'tier-l-session' },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('exactly six lanes');
	});

	test('rejects a two-lane initial base wave below the depth tier M floor', async () => {
		gateInternals.resolvePrReviewDiffStats = () => ({
			changedLines: 300,
			changedFiles: 12,
			hasSubmoduleChange: false,
		});
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 2,
				lanes: [
					lane('sweep-a', PR_REVIEW_BASE_DIMENSION_IDS[0], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3),
					]),
					lane('sweep-b', PR_REVIEW_BASE_DIMENSION_IDS[3], undefined, [
						...PR_REVIEW_BASE_DIMENSION_IDS.slice(3),
					]),
				],
			},
			directory,
			{ sessionID: 'tier-m-floor-session' },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('requires between 3 and 6 lanes');
	});

	test('rejects a consolidated retry base batch at depth tier L through the real dispatch_lanes_async tool surface', async () => {
		// The initial-wave structural check in dispatch-lanes.ts only runs when
		// prReviewBaseDispatches is still empty; a retry batch skips that block
		// entirely and depends solely on enforcePrReviewBaseDimensions (called
		// unconditionally below it) to reject tier-L consolidation. This proves
		// that rejection survives through the actual tool call, not just a
		// direct unit call to the internal gate function.
		uniqueSessionOps();
		const initial = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 6,
				lanes: PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) =>
					lane(`base-${workflowLane}`, workflowLane),
				),
			},
			directory,
			{ sessionID: 'tier-l-retry-session' },
		);
		expect(initial.success).toBe(true);

		const retry = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 1,
				lanes: [
					lane(
						'retry-consolidated',
						PR_REVIEW_BASE_DIMENSION_IDS[0],
						undefined,
						[...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 2)],
					),
				],
			},
			directory,
			{ sessionID: 'tier-l-retry-session' },
		);
		expect(retry.success).toBe(false);
		expect(retry.message).toContain(
			'depth tier L requires one dedicated lane per dimension',
		);
	});

	test('rejects owned_workflow_lanes outside PR_REVIEW discovery lanes', async () => {
		await activatePrWorkflow(
			directory,
			'feedback-owned-session',
			'PR_FEEDBACK',
		);
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				pr_head_sha: 'abc123',
				feedback_inventory: ['FB-001'],
				lanes: [
					{
						...lane('verify-a', undefined, ['FB-001']),
						owned_workflow_lanes: ['verify-a', 'verify-b'],
					},
				],
			},
			directory,
			{ sessionID: 'feedback-owned-session' },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('must not declare owned_workflow_lanes');
	});

	test('blocks review dispatch that omits the explicit workflow mode', async () => {
		await activatePrWorkflow(directory, 'review-session', 'PR_REVIEW');
		const result = await executeDispatchLanesAsync(
			{ lanes: [lane('lane-a')] },
			directory,
			{ sessionID: 'review-session' },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'active PR_REVIEW dispatch requires pr_head_sha',
		);
	});

	test('blocks PR feedback verification without exact head provenance', async () => {
		await activatePrWorkflow(directory, 'feedback-session', 'PR_FEEDBACK');
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-feedback:verification',
				feedback_inventory: ['FB-001', 'FB-002'],
				lanes: [lane('verify-a', undefined, ['FB-001'])],
			},
			directory,
			{ sessionID: 'feedback-session' },
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('requires pr_head_sha');
	});
});
