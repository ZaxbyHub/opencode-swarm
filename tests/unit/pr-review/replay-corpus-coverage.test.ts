import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	activatePrWorkflow,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

/**
 * Issue #2385 replay corpus — historical failure shapes 4 from tracker
 * #2380: the 4/6 and 5/6 terminal-coverage shapes. The pre-#2383 completion
 * path hard-coded "exactly five successes and one missing dimension" — a
 * 4/6 run (or any other honest gap pattern) could neither complete nor
 * disclose its gaps, so validated findings were discarded entirely.
 *
 * Replayed through the REGISTERED `complete_pr_workflow` tool path: every
 * launched lane terminal, N-of-6 settlement produces a truthful PARTIAL
 * report with the explicit unresolved list, and APPROVE is impossible.
 */

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

beforeEach(() => {
	directory = canonicalMkdtemp('pr-review-corpus-coverage-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

async function establishMixedCoverage(successCount: number): Promise<string[]> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const successful = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, successCount);
	const failed = PR_REVIEW_BASE_DIMENSION_IDS.slice(successCount);
	const okLanes = successful.map((workflowLane) => ({
		laneId: `ok-${workflowLane}`,
		workflowLane,
	}));
	if (okLanes.length > 0) {
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			okLanes,
			{
				batchId: 'corpus-ok',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'corpus-ok',
			'swarm-pr-review:base',
			okLanes,
		);
	}
	const failedLanes = failed.map((workflowLane) => ({
		laneId: `failed-${workflowLane}`,
		workflowLane,
	}));
	if (failedLanes.length > 0) {
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			failedLanes,
			{
				batchId: 'corpus-failed',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'corpus-failed',
			'swarm-pr-review:base',
			failedLanes,
			{ status: 'error', workflowLaneFailureClass: 'contract' },
		);
	}
	return failed;
}

async function attemptCompletion(
	verdict: string,
): Promise<{ success: boolean; message?: string }> {
	return JSON.parse(
		await executeCompletePrWorkflow(
			{
				mode: 'PR_REVIEW',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				report_verdict: verdict,
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		),
	) as { success: boolean; message?: string };
}

describe('replay corpus: 4/6 and 5/6 terminal coverage (#2380 shape 4)', () => {
	test('5/6 coverage settles as truthful PARTIAL and can never APPROVE', async () => {
		const unresolved = await establishMixedCoverage(5);
		expect(unresolved).toHaveLength(1);

		const approve = await attemptCompletion('APPROVE');
		expect(approve.success).toBe(false);
		// The settlement ADMITTED the partial coverage (the pre-#2383 code
		// hard-blocked everything except exactly-five-successes): the verdict
		// restriction message proves the N-of-6 classification ran.
		expect(approve.message).toContain(
			'PARTIAL completion allows report_verdict',
		);
	});

	test('4/6 coverage settles as truthful PARTIAL and can never APPROVE', async () => {
		const unresolved = await establishMixedCoverage(4);
		expect(unresolved).toHaveLength(2);

		const approve = await attemptCompletion('APPROVE');
		expect(approve.success).toBe(false);
		// Identical classification to the 5/6 shape: the settlement admits
		// ANY honest gap pattern, not only exactly-five-successes.
		expect(approve.message).toContain(
			'PARTIAL completion allows report_verdict',
		);
	});

	test('0/6 coverage completes only as the INCOMPLETE operational report', async () => {
		await establishMixedCoverage(0);
		const approve = await attemptCompletion('APPROVE');
		expect(approve.success).toBe(false);
		const incomplete = await attemptCompletion('INCOMPLETE');
		expect(incomplete.success).toBe(true);
	});
});
