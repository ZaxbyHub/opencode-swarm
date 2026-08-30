import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	activatePrWorkflow,
	admitPrReviewPartialBaseCoverage,
	assertPrReviewBaseCoverageSettled,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_REQUIRED_MICRO_LANE_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
	settleReviewerPhase,
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

beforeEach(() => {
	directory = canonicalMkdtemp('pr-terminal-settlement-');
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

type Dimension = (typeof PR_REVIEW_BASE_DIMENSION_IDS)[number];

/**
 * Build a run with `successfulCount` covered dimensions and the remainder
 * terminally failed with a typed contract failure (issue #2383 N-of-6 shape).
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

describe('terminal N-of-6 settlement (issue #2383) — parameterized N=0..6', () => {
	for (const successfulCount of [0, 1, 2, 3, 4, 5]) {
		test(`N=${successfulCount} admits, settles, and reports the truthful kind`, async () => {
			const { unresolved, records } = await establishNOfSix(successfulCount);
			if (unresolved.length === 0) return; // N=6 needs no disclosure
			const result = await writePartial(records, unresolved);
			// N=0 cannot write findings (records min 1 with zero candidates is
			// satisfied by the sentinel ONLY when at least one dimension is
			// covered); zero coverage settles at completion instead.
			if (successfulCount === 0) {
				expect(result.success).toBe(false);
				return;
			}
			expect(result.success).toBe(true);
			const settled = await assertPrReviewBaseCoverageSettled(
				directory,
				PR_ARTIFACT_SESSION_ID,
			);
			expect(settled.settlement.kind).toBe('PARTIAL');
			expect(settled.settlement.coveredDimensions).toHaveLength(
				successfulCount,
			);
			expect(
				settled.settlement.unresolvedDimensions.map((entry) => entry.dimension),
			).toEqual(unresolved);
			for (const entry of settled.settlement.unresolvedDimensions) {
				expect(entry.terminalState).toBe('FAILED');
				expect(entry.reasonKind).toBe('lane_failure');
				expect(entry.failureClass).toBe('contract');
				expect(entry.terminalEventId).toBeTruthy();
			}
		});
	}

	test('N=6 (all covered) needs no disclosure and settles COMPLETE', async () => {
		const { records } = await establishNOfSix(6);
		const settled = await assertPrReviewBaseCoverageSettled(
			directory,
			PR_ARTIFACT_SESSION_ID,
		);
		expect(settled.settlement.kind).toBe('COMPLETE');
		expect(settled.settlement.unresolvedDimensions).toEqual([]);
		// A disclosure on a fully covered run is rejected.
		const result = await writePartial(records, ['intent-architecture']);
		expect(result.success).toBe(false);
	});
});

describe('PARTIAL end-to-end completion + immutable disclosure (issue #2383)', () => {
	test('PARTIAL run completes end-to-end with report_verdict REQUEST_CHANGES', async () => {
		const { unresolved, records } = await establishNOfSix(4);
		const admitted = await writePartial(records, unresolved);
		expect(admitted.success).toBe(true);
		// Micro-lane CLEAN attestations + trigger evaluation over the covered
		// inventory, exactly as the full-coverage ladder requires.
		const MICRO_HEADER =
			'[CANDIDATE] | candidate_id | micro_lane | severity | category | file:line | claim | invariant_violated | evidence_summary | confidence | risk_impact | risk_tags';
		const triggerRows: Array<Record<string, string>> = [];
		for (const [
			index,
			workflowLane,
		] of PR_REVIEW_REQUIRED_MICRO_LANE_IDS.entries()) {
			const batchId = `micro-${index}`;
			const laneId = `micro-lane-${index}`;
			await persistPrReviewBatch(
				directory,
				batchId,
				'swarm-pr-review:micro',
				[{ laneId, workflowLane }],
				{
					textOverride: `${MICRO_HEADER}
[CLEAN] | ${workflowLane} | exact reviewed diff | no finding after focused invariant review`,
				},
			);
			triggerRows.push({
				trigger_id: workflowLane,
				result: 'MATCHED',
				evidence: `Test fixture evidence for ${workflowLane}`,
				source_batch_id: batchId,
				source_lane_id: laneId,
			});
		}
		const triggerRelative = path.join(
			'pr-review',
			'terminal-settlement-run',
			'trigger-eval.json',
		);
		const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
		await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
		await fs.writeFile(
			triggerAbsolute,
			JSON.stringify({ rows: triggerRows }),
			'utf8',
		);
		await markPrReviewTriggerEvaluationComplete(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'terminal-settlement-run',
			triggerRelative,
		);
		// Reviewer phase over the covered inventory: every candidate DISPROVED
		// (no critic inventory, no handoff obligation).
		const itemIds = records.map((record) => record.finding_id as string);
		await settleReviewerPhase(
			directory,
			'terminal-settlement-run',
			itemIds.map(
				(id) =>
					`[REVIEWED] | ${id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | refuted by direct test | probe | reviewer | ORDINARY | `,
			),
			itemIds,
		);
		const reviewerRecords = records.map((record) => ({
			finding_id: record.finding_id as string,
			status: 'DISPROVED' as const,
			file_line: 'file.ts:1',
			evidence: 'refuted by direct test',
			next_action: 'suppress_with_reason' as const,
			severity: 'NONE' as const,
		}));
		for (const boundary of ['post_reviewer', 'post_critic'] as const) {
			const raw = await executeWritePrReviewArtifact(
				{
					kind: 'findings',
					run_id: 'terminal-settlement-run',
					pr_head_sha: PR_ARTIFACT_HEAD_SHA,
					boundary,
					records: reviewerRecords,
				},
				directory,
				{ sessionID: PR_ARTIFACT_SESSION_ID },
			);
			expect(JSON.parse(raw).success).toBe(true);
		}
		// The central happy path under test: PARTIAL + REQUEST_CHANGES completes.
		const status = await completePrWorkflow(
			directory,
			PR_ARTIFACT_SESSION_ID,
			'PR_REVIEW',
			PR_ARTIFACT_HEAD_SHA,
			{ reportVerdict: 'REQUEST_CHANGES' },
		);
		expect(status).toBe('completed');
		expect(
			await readPrWorkflowGateState(directory, PR_ARTIFACT_SESSION_ID),
		).toBeNull();
	});

	test('re-admission after evidence drift hits the immutable-disclosure branch', async () => {
		const { unresolved, records } = await establishNOfSix(4);
		const admitted = await writePartial(records, unresolved);
		expect(admitted.success).toBe(true);
		// A late success for one declared-unresolved dimension changes the
		// derived settlement; declaring the NEW derived set passes the
		// exact-match check but must then fail against the IMMUTABLE existing
		// disclosure (PRR-005: this branch had no test coverage).
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
			admitPrReviewPartialBaseCoverage(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'terminal-settlement-run',
				[unresolved[1]!],
			),
		).rejects.toThrow('differs from the immutable existing disclosure');
		// Re-declaring the ORIGINAL set after the drift fails earlier, at the
		// exact-match check (derived is now just unresolved[1]).
		await expect(
			admitPrReviewPartialBaseCoverage(
				directory,
				PR_ARTIFACT_SESSION_ID,
				'terminal-settlement-run',
				[unresolved[0]!, unresolved[1]!],
			),
		).rejects.toThrow(
			'declaration must exactly match the derived terminal settlement',
		);
	});
});
