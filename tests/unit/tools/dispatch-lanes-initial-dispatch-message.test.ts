import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';

// Split from dispatch-lanes-pr-workflow-gate.test.ts (FR-006: that file is over
// the 500-line ratchet cap and must not grow). Discoverability fix for the
// PR-review deadlock: the initial base-dispatch BLOCKED message must NAME the
// six valid dimension IDs so an orchestrator can correct its next call without
// grepping plugin source — the captured PR #2177 run burned ~8 rejected
// dispatches on this.

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

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-message-');
	await initializeGitRepository(directory);
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveCurrentGitHeadAsync = async (dir) =>
		gateInternals.resolveCurrentGitHead(dir);
	gateInternals.resolveIsWorkingTreeCleanAsync = async (dir) =>
		gateInternals.resolveIsWorkingTreeClean(dir);
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 12,
		changedFiles: 2,
		hasSubmoduleChange: false,
	});
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

describe('initial PR_REVIEW base dispatch BLOCKED message discoverability', () => {
	test('tier-S partition rejection names all six valid dimension IDs', async () => {
		const result = await executeDispatchLanesAsync(
			{
				mode: 'swarm-pr-review:base',
				pr_head_sha: 'abc123',
				base_sha: 'def456',
				base_ref: 'origin/main',
				max_concurrent: 2,
				lanes: [
					{
						id: 'sweep-a',
						agent: 'explorer',
						prompt: 'Inspect sweep-a',
						workflow_lane: PR_REVIEW_BASE_DIMENSION_IDS[0],
						owned_workflow_lanes: [...PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3)],
					},
					{
						id: 'sweep-b',
						agent: 'explorer',
						prompt: 'Inspect sweep-b',
						workflow_lane: PR_REVIEW_BASE_DIMENSION_IDS[3],
						owned_workflow_lanes: [...PR_REVIEW_BASE_DIMENSION_IDS.slice(3, 5)],
					},
				],
			},
			directory,
			{ sessionID: 'message-session' },
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'partition all six dimensions exactly once',
		);
		expect(result.message).toContain('valid dimensions:');
		for (const dimensionId of PR_REVIEW_BASE_DIMENSION_IDS) {
			expect(result.message).toContain(dimensionId);
		}
	});
});
