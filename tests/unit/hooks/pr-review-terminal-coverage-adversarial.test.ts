import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	_test_exports,
	activatePrWorkflow,
	allowedPrReviewReportVerdicts,
	assertPrReviewBaseCoverageSettled,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
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

describe('terminal N-of-6 adversarial cases (issue #2383)', () => {
	test('duplicate declared dimensions are rejected by the arg schema', async () => {
		const { records } = await establishNOfSix(5);
		const result = await writePartial(records, [
			'intent-architecture',
			'intent-architecture',
		]);
		expect(result.success).toBe(false);
	});

	test('unknown dimension ids are rejected by the arg schema', async () => {
		const { records } = await establishNOfSix(5);
		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: 'terminal-settlement-run',
				pr_head_sha: PR_ARTIFACT_HEAD_SHA,
				boundary: 'post_explorer',
				records,
				partial_base_coverage: {
					unresolved_dimensions: ['not-a-dimension'],
				},
			},
			directory,
			{ sessionID: PR_ARTIFACT_SESSION_ID },
		);
		expect(JSON.parse(raw).success).toBe(false);
	});

	test('a declaration that omits a derived unresolved dimension is rejected', async () => {
		await establishNOfSix(4); // two unresolved dimensions
		const result = await writePartial(
			[0, 1, 2, 3].map((index) => ({
				finding_id: `C-${index}`,
				status: 'PENDING',
				file_line: 'file.ts:1',
				evidence: `authoritative candidate ${index}`,
				next_action: 'route_to_reviewer',
				severity: 'HIGH',
			})),
			[PR_REVIEW_BASE_DIMENSION_IDS[4]!],
		);
		expect(result.success).toBe(false);
	});

	test('one lane owning multiple failed dimensions settles both with shared evidence', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const good = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 4);
		const goodLanes = good.map((workflowLane) => ({
			laneId: `ok-${workflowLane}`,
			workflowLane,
		}));
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			goodLanes,
			{
				batchId: 'base-good',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-good',
			'swarm-pr-review:base',
			goodLanes,
		);
		// Singleton terminal failures first — the retry rule requires every
		// consolidated dimension to already have a terminal non-successful
		// record before a consolidated retry lane may own it.
		for (const workflowLane of [
			PR_REVIEW_BASE_DIMENSION_IDS[4]!,
			PR_REVIEW_BASE_DIMENSION_IDS[5]!,
		]) {
			const singleton = [{ laneId: `singleton-${workflowLane}`, workflowLane }];
			await enforcePrReviewBaseDimensions(
				directory,
				PR_ARTIFACT_SESSION_ID,
				singleton,
				{
					batchId: `base-singleton-${workflowLane}`,
					prHeadSha: PR_ARTIFACT_HEAD_SHA,
					prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
				},
			);
			await persistPrReviewBatch(
				directory,
				`base-singleton-${workflowLane}`,
				'swarm-pr-review:base',
				singleton,
				{ status: 'error', workflowLaneFailureClass: 'contract' },
			);
		}
		// One consolidated retry lane owning BOTH remaining dimensions, failing
		// once — its terminal result is the LATEST evidence for both.
		const consolidatedLane = {
			laneId: 'consolidated-tail',
			workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[4]!,
			ownedWorkflowLanes: [
				PR_REVIEW_BASE_DIMENSION_IDS[4]!,
				PR_REVIEW_BASE_DIMENSION_IDS[5]!,
			],
		};
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			[consolidatedLane],
			{
				batchId: 'base-consolidated-failed',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-consolidated-failed',
			'swarm-pr-review:base',
			[consolidatedLane],
			{ status: 'error', workflowLaneFailureClass: 'resource' },
		);
		const result = await writePartial(
			[0, 1, 2, 3].map((index) => ({
				finding_id: `C-${index}`,
				status: 'PENDING',
				file_line: 'file.ts:1',
				evidence: `authoritative candidate ${index}`,
				next_action: 'route_to_reviewer',
				severity: 'HIGH',
			})),
			[PR_REVIEW_BASE_DIMENSION_IDS[4]!, PR_REVIEW_BASE_DIMENSION_IDS[5]!],
		);
		expect(result.success).toBe(true);
		const settled = await assertPrReviewBaseCoverageSettled(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(settled.settlement.kind).toBe('PARTIAL');
		const laneIds = new Set(
			settled.settlement.unresolvedDimensions.map((entry) => entry.laneId),
		);
		expect(laneIds).toEqual(new Set(['consolidated-tail']));
	});

	test('an in-flight lane in an unresolved dimension blocks settlement', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const lanes = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5).map(
			(workflowLane) => ({ laneId: `ok-${workflowLane}`, workflowLane }),
		);
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lanes,
			{
				batchId: 'base-five',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-five',
			'swarm-pr-review:base',
			lanes,
		);
		// The sixth lane still has a non-terminal (running) delegation record.
		const liveLane = [
			{ laneId: 'live-six', workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[5]! },
		];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			liveLane,
			{
				batchId: 'base-live',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-live',
			'swarm-pr-review:base',
			liveLane,
			{ status: 'running' },
		);
		await expect(
			assertPrReviewBaseCoverageSettled(directory, PR_ARTIFACT_SESSION_ID),
		).rejects.toThrow(/live lanes for/);
		const result = await writePartial(
			[
				{
					finding_id: 'CLEAN-REVIEW',
					status: 'PENDING',
					file_line: 'src/index.ts:1',
					evidence: 'sentinel',
					next_action: 'route_to_reviewer',
					severity: 'NONE',
				},
			],
			[PR_REVIEW_BASE_DIMENSION_IDS[5]!],
		);
		expect(result.success).toBe(false);
	});

	test('a dimension with no typed terminal failure is not admissible as FAILED', async () => {
		await activatePrWorkflow(directory, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const lanes = PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 5).map(
			(workflowLane) => ({ laneId: `ok-${workflowLane}`, workflowLane }),
		);
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			lanes,
			{
				batchId: 'base-five',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		await persistPrReviewBatch(
			directory,
			'base-five',
			'swarm-pr-review:base',
			lanes,
		);
		const sixth = [
			{ laneId: 'untyped-six', workflowLane: PR_REVIEW_BASE_DIMENSION_IDS[5]! },
		];
		await enforcePrReviewBaseDimensions(
			directory,
			PR_ARTIFACT_SESSION_ID,
			sixth,
			{
				batchId: 'base-sixth',
				prHeadSha: PR_ARTIFACT_HEAD_SHA,
				prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
			},
		);
		// Terminal error WITHOUT a typed failure class.
		await persistPrReviewBatch(
			directory,
			'base-sixth',
			'swarm-pr-review:base',
			sixth,
			{ status: 'error' },
		);
		const result = await writePartial(
			[
				{
					finding_id: 'CLEAN-REVIEW',
					status: 'PENDING',
					file_line: 'src/index.ts:1',
					evidence: 'sentinel',
					next_action: 'route_to_reviewer',
					severity: 'NONE',
				},
			],
			[PR_REVIEW_BASE_DIMENSION_IDS[5]!],
		);
		expect(result.success).toBe(false);
	});

	test('a late partial success after admission invalidates the immutable disclosure', async () => {
		// N=4: a late lane SUCCEEDS for one of the two declared-unresolved
		// dimensions, so the re-derived unresolved set no longer matches the
		// immutable disclosure — settlement BLOCKs instead of re-crediting.
		const { unresolved, records } = await establishNOfSix(4);
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
