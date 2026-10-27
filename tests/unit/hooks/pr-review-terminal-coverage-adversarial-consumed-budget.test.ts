/**
 * FR-006 500-line test-file cap: the consumed-budget admission legs split out
 * from pr-review-terminal-coverage-adversarial.test.ts.
 *
 * #3312 AC10 supersedes #2383's unconsumed-budget admission pins in the three
 * post-admission legs below: the partial disclosure admission now refuses a
 * contract-class dimension while its legacy retry budget remains, so each leg
 * first consumes the ONE legacy contract retry for every unresolved dimension
 * (the enforcePrReviewBaseDimensions prReviewContractRetry mechanism — one
 * singleton lane per dimension; the unlaunched retry dispatch contributes no
 * lane evidence, so the derived FAILED/contract settlement is unchanged and
 * the admission is legitimate).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	assertPrReviewBaseCoverageSettled,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

let directory = '';
const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveWorkingTreeClean = _test_exports.resolveIsWorkingTreeClean;
const originalResolveWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;
beforeEach(async () => {
	directory = canonicalMkdtemp('pr-terminal-settlement-');
	await fs.mkdir(path.join(directory, '.git'), { recursive: true });
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
	closeAllProjectDbs();
	await fs.rm(directory, { recursive: true, force: true });
});

type Dimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];
/**
 * Build a run with covered and terminally failed dimensions (issue #2383).
 */
async function establishNOfSix(successfulCount: number): Promise<{
	unresolved: Dimension[];
	records: Array<Record<string, unknown>>;
}> {
	await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
		prHeadSha: PR_ARTIFACT_HEAD_SHA,
	});
	const successful = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, successfulCount);
	const failed = PR_REVIEW_BASE_DIMENSION_IDS.slice(successfulCount);
	if (successful.length > 0) {
		const lanes = successful.map((workflowLane) => ({
			laneId: `ok-${workflowLane}`,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lanes,
			{
				batchId: 'base-successful',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-successful',
			'swarm-pr-review:base',
			lanes,
		);
	}
	for (const [index, workflowLane] of failed.entries()) {
		const batchId = `base-failed-${index}`;
		const lanes = [{ laneId: `failed-${workflowLane}`, workflowLane }];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lanes,
			{
				batchId,
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			batchId,
			'swarm-pr-review:base',
			lanes,
			{
				status: 'error',
				workflowLaneFailureClass: 'contract',
			},
		);
	}
	return {
		unresolved: failed,
		// Each successful lane's default candidate row contributes C-<index>
		// to the discovered inventory; the post_explorer records must cover it.
		records: successful.map((_dimension, index) => ({
			finding_id: `C-${index}`,
			status: 'PENDING',
			file_line: 'file.ts:1',
			evidence: `authoritative candidate ${index}`,
			next_action: 'route_to_reviewer',
			severity: 'HIGH',
		})),
	};
}

async function writePartial(
	records: Array<Record<string, unknown>>,
	unresolved: readonly Dimension[],
): Promise<{ success: boolean; [key: string]: unknown }> {
	const raw = await executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: 'terminal-settlement-run',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			boundary: 'post_explorer',
			records,
			partial_base_coverage: { unresolved_dimensions: [...unresolved] },
		},
		directory,
		{ sessionID: PR_ARTIFACT_SESSION_ID },
	);
	return JSON.parse(raw) as { success: boolean; [key: string]: unknown };
}

async function consumeLegacyContractRetries(
	unresolved: readonly Dimension[],
): Promise<void> {
	for (const [index, workflowLane] of unresolved.entries()) {
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[{ laneId: `contract-retry-${index}`, workflowLane }],
			{
				batchId: `contract-retry-${index}`,
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewContractRetry: true,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
	}
}

describe('terminal N-of-6 adversarial cases (issue #2383)', () => {
	test('a late partial success after admission invalidates the immutable disclosure', async () => {
		// N=4: a late lane SUCCEEDS for one of the two declared-unresolved
		// dimensions, so the re-derived unresolved set no longer matches the
		// immutable disclosure — settlement BLOCKs instead of re-crediting.
		const { unresolved, records } = await establishNOfSix(4);
		await consumeLegacyContractRetries(unresolved);
		const admitted = await writePartial(records, unresolved);
		expect(admitted.success).toBe(true);
		const lateLane = [
			{ laneId: `late-${unresolved[0]}`, workflowLane: unresolved[0]! },
		];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lateLane,
			{
				batchId: 'base-late-success',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-late-success',
			'swarm-pr-review:base',
			lateLane,
		);
		await expect(
			assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
		).rejects.toThrow(/no longer matches the derived terminal settlement/);
	});

	test('a late success that completes all six coverage settles COMPLETE over the stale disclosure', async () => {
		// Complementary case: the late success is the LAST dimension, so the
		// stale disclosure is irrelevant and settlement reports COMPLETE.
		const { unresolved, records } = await establishNOfSix(5);
		await consumeLegacyContractRetries(unresolved);
		const admitted = await writePartial(records, unresolved);
		expect(admitted.success).toBe(true);
		const lateLane = [
			{ laneId: `late-${unresolved[0]}`, workflowLane: unresolved[0]! },
		];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lateLane,
			{
				batchId: 'base-late-success',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-late-success',
			'swarm-pr-review:base',
			lateLane,
		);
		const settled = await assertPrReviewBaseCoverageSettled(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(settled.settlement.kind).toBe('COMPLETE');
	});

	test('a revision-digest drift fails closed as uncreditable live coverage', async () => {
		const { unresolved, records } = await establishNOfSix(5);
		await consumeLegacyContractRetries(unresolved);
		const admitted = await writePartial(records, unresolved);
		expect(admitted.success).toBe(true);
		// Worktree drift: revision-aware coverage stops crediting the stale
		// artifacts, which read as still-live obligations — the fail-closed
		// outcome (settle or re-run; never re-credit stale evidence).
		_test_exports.resolvePrWorkflowRevisionDigest = () => 'f'.repeat(64);
		try {
			await expect(
				assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
			).rejects.toThrow(/still has live lanes for/);
		} finally {
			_test_exports.resolvePrWorkflowRevisionDigest = () =>
				PR_ARTIFACT_REVISION_DIGEST;
		}
	});
});
