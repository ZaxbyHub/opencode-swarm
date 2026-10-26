import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PR_REVIEW_TRIGGER_DEFINITIONS } from '../../../src/background/pr-review-trigger-contract.js';
import {
	activatePrWorkflow,
	completePrWorkflow,
	enforcePrReviewBaseDimensions,
	_test_exports as gateInternals,
	markPrReviewTriggerEvaluationComplete,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrReviewFinalFindingPolicyForReport,
	readPrReviewTerminalCoverageForReport,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { readPrReviewTerminalCoverageForReport as readTerminalCoverageFromCompletion } from '../../../src/pr-review/completion.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { LEGACY_PR_REVIEW_RESILIENCE_POLICY } from '../pr-review-test-policy.js';

// Issue #2840: a PR_REVIEW completion whose durable trigger-eval receipt
// carries a disclosed coverage degradation (dead family) must BLOCK verdict
// APPROVE at the gate — both the reducer-owned finalization transition and
// the preflight check — and both report projections must exclude APPROVE.
// Without the degradation the matrix is unchanged (APPROVE stays permitted).

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('issue-2840-completion-');
	// PR review finding (Copilot): fs is node:fs/promises — the mkdir promise
	// must be awaited inside the async beforeEach, not left floating.
	await fs.mkdir(path.join(directory, '.git'), { recursive: true });
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => HEAD_SHA;
	gateInternals.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = ORIGINALS.head;
	gateInternals.resolveCurrentGitHeadAsync = ORIGINALS.headAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = ORIGINALS.revision;
	gateInternals.resolveIsWorkingTreeClean = ORIGINALS.clean;
	gateInternals.resolveIsWorkingTreeCleanAsync = ORIGINALS.cleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Minimal COMPLETE-settlement fixture: six settled base lanes only. */
async function establishCompleteBase(): Promise<void> {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', {
		prHeadSha: HEAD_SHA,
	});
	const baseLanes = PR_REVIEW_BASE_DIMENSION_IDS.map((workflowLane) => ({
		laneId: workflowLane,
		workflowLane,
	}));
	await enforcePrReviewBaseDimensions(directory, SESSION_ID, baseLanes, {
		batchId: 'base-all',
		prHeadSha: HEAD_SHA,
		prReviewResiliencePolicy: LEGACY_PR_REVIEW_RESILIENCE_POLICY,
	});
	await persistPrReviewBatch(
		directory,
		'base-all',
		'swarm-pr-review:base',
		baseLanes,
		{
			cleanPerLane: true,
		},
	);
}

/** Writes a v2 trigger-eval receipt for the run; `withDegradation` adds one
 * dead-family coverage_degradations entry. Mirrors the shape the writer
 * persists (see pr-workflow-gate-degraded-inventory.test.ts). */
async function writeTriggerReceipt(
	runId: string,
	withDegradation: boolean,
	options: { remark?: boolean } = {},
): Promise<void> {
	// `remark=false` only overwrites the receipt file — the gate binds a run's
	// trigger-eval path exactly once, so re-marking for a second run id throws.
	const remark = options.remark ?? true;
	const rows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition) => ({
		trigger_id: definition.id,
		scope: definition.scope,
		trigger_row: definition.trigger_row,
		micro_lane: definition.micro_lane,
		result: 'MATCHED' as const,
		evidence: `fixture evidence for ${definition.id}`,
		source_batch_id: `micro-${definition.id}`,
		source_lane_id: `micro-lane-${definition.id}`,
	}));
	const coverage_degradations = withDegradation
		? [
				{
					trigger_id: rows[0]!.trigger_id,
					source_batch_id: rows[0]!.source_batch_id,
					source_lane_id: rows[0]!.source_lane_id,
					reason:
						'liveness-terminal dead family: lane settled stale with typed liveness class (presumed host abandonment), no retained artifact; family disclosed unattested',
				},
			]
		: [];
	const triggerRelative = path.join('pr-review', runId, 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({
			schema_version: 2,
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: 'def456',
			evaluated_at: '2026-09-20T00:00:00.000Z',
			dispatched_micro_lane_count: rows.length,
			trigger_count: rows.length,
			matched_count: rows.length,
			not_triggered_count: 0,
			no_match_count: 0,
			rows,
			coverage_degradations,
		}),
		'utf-8',
	);
	if (remark) {
		await markPrReviewTriggerEvaluationComplete(
			directory,
			SESSION_ID,
			runId,
			triggerRelative,
		);
	}
}

/** Full finding-policy evidence chain (recipe from
 * write-pr-review-artifact-policy-integration.test.ts — CONFIRMED HIGH
 * findings with an UPHELD critic settlement; every boundary write is asserted
 * successful so a silently-rejected write cannot fake the run binding: the
 * artifact writer returns a JSON string instead of throwing on rejection). */
async function establishFindingPolicyEvidence(runId: string): Promise<void> {
	await establishPrReviewPrerequisites(directory, runId);
	const findingIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
		(_dimension, index) => `C-${index}`,
	);
	const explorerRecords = findingIds.map((finding_id) => ({
		finding_id,
		status: 'PENDING' as const,
		file_line: 'src/index.ts:1',
		evidence: 'discovery evidence',
		next_action: 'route_to_reviewer' as const,
		severity: 'HIGH' as const,
	}));
	const reviewerRecords = findingIds.map((finding_id, index) => ({
		finding_id,
		status: index === 0 ? ('DISPROVED' as const) : ('CONFIRMED' as const),
		file_line: 'src/index.ts:1',
		evidence: 'reviewer evidence',
		next_action:
			index === 0
				? ('suppress_with_reason' as const)
				: ('route_to_critic' as const),
		severity: index === 0 ? ('NONE' as const) : ('HIGH' as const),
		...(index === 0
			? {}
			: { risk_impact: 'ORDINARY' as const, risk_tags: [] as string[] }),
	}));
	const criticRecords = reviewerRecords.map((record) =>
		record.status === 'DISPROVED'
			? record
			: { ...record, next_action: 'report' as const },
	);
	const reviewerRows = findingIds
		.map((finding_id, index) =>
			index === 0
				? `[REVIEWED] | ${finding_id} | DISPROVED | STRUCTURALLY_PROVEN | NONE | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `
				: `[REVIEWED] | ${finding_id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
		)
		.join('\n');
	const criticRows = findingIds
		.slice(1)
		.map(
			(finding_id) =>
				`[CRITIC] | ${finding_id} | UPHELD | HIGH | reason | no change`,
		)
		.join('\n');
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${runId}-rv`,
				workflowLane: `${runId}-rv`,
				reviewItemIds: [...findingIds],
			},
		],
		{ batchId: `${runId}-rv`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${runId}-rv`,
		'swarm-pr-review:reviewer',
		[{ laneId: `${runId}-rv`, workflowLane: `${runId}-rv` }],
		{ textOverride: reviewerRows },
	);
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'critic',
		[
			{
				laneId: `${runId}-cr`,
				agent: 'critic',
				workflowLane: `${runId}-cr`,
				reviewItemIds: findingIds.slice(1),
			},
		],
		{ batchId: `${runId}-cr`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${runId}-cr`,
		'swarm-pr-review:critic',
		[{ laneId: `${runId}-cr`, workflowLane: `${runId}-cr` }],
		{ textOverride: criticRows },
	);
	for (const [boundary, records] of [
		['post_explorer', explorerRecords],
		['post_reviewer', reviewerRecords],
		['post_critic', criticRecords],
	] as const) {
		const raw = await executeWritePrReviewArtifact(
			{
				kind: 'findings',
				run_id: runId,
				pr_head_sha: HEAD_SHA,
				boundary,
				records,
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(raw, `${runId} ${boundary} artifact write must succeed`).toContain(
			'"success": true',
		);
	}
}

describe('issue #2840 — gate completion blocks APPROVE under disclosed degradation', () => {
	test('COMPLETE settlement + dead-family degradation: report_verdict APPROVE is BLOCKED naming the degradation', async () => {
		await establishCompleteBase();
		await writeTriggerReceipt('run-2840-degraded', true);
		await expect(
			completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'APPROVE',
			}),
		).rejects.toThrow(/discloses a coverage degradation/);
	});

	test('COMPLETE settlement + dead-family degradation: REQUEST_CHANGES passes both verdict gates', async () => {
		await establishCompleteBase();
		await writeTriggerReceipt('run-2840-degraded', true);
		let message = '';
		try {
			await completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'REQUEST_CHANGES',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// The fixture stops short of the full terminal-ready evidence chain, so
		// completion eventually throws — but NEVER a verdict-matrix rejection:
		// both the reducer finalization and the preflight accepted
		// REQUEST_CHANGES. That ordering is exactly what this test pins.
		expect(message).not.toMatch(/discloses a coverage degradation/);
		expect(message).not.toMatch(/allows report_verdict/);
		expect(message.length).toBeGreaterThan(0);
	});

	test('control: the same fixture WITHOUT a degradation keeps APPROVE verdict-permitted', async () => {
		await establishCompleteBase();
		await writeTriggerReceipt('run-2840-clean', false);
		let message = '';
		try {
			await completePrWorkflow(directory, SESSION_ID, 'PR_REVIEW', HEAD_SHA, {
				reportVerdict: 'APPROVE',
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).not.toMatch(/discloses a coverage degradation/);
		expect(message).not.toMatch(/allows report_verdict/);
		expect(message.length).toBeGreaterThan(0);
	});
});

describe('issue #2840 — report projections exclude APPROVE under disclosed degradation', () => {
	test('projection: terminal coverage report excludes APPROVE with a degradation and permits it without one', async () => {
		await establishCompleteBase();
		await writeTriggerReceipt('run-2840-projection', true);
		const degraded = await readTerminalCoverageFromCompletion(
			directory,
			SESSION_ID,
		);
		expect(degraded?.kind).toBe('COMPLETE');
		expect([...(degraded?.allowedVerdicts ?? [])]).toEqual([
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);

		// Overwrite the SAME run's receipt without the degradation (the run's
		// trigger-eval path is bound once; the reader re-reads the file).
		await writeTriggerReceipt('run-2840-projection', false, { remark: false });
		const clean = await readTerminalCoverageFromCompletion(
			directory,
			SESSION_ID,
		);
		expect([...(clean?.allowedVerdicts ?? [])]).toEqual([
			'APPROVE',
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
	});

	test('projection: gate re-export of the terminal coverage report agrees with the completion boundary', async () => {
		await establishCompleteBase();
		await writeTriggerReceipt('run-2840-reexport', true);
		const viaGate = await readPrReviewTerminalCoverageForReport(
			directory,
			SESSION_ID,
		);
		expect([...(viaGate?.allowedVerdicts ?? [])]).not.toContain('APPROVE');
	});

	test('projection: final finding policy report excludes APPROVE with a degradation', async () => {
		// establishPrReviewPrerequisites already marked this runId's
		// trigger-eval; overwrite its receipt with the degradation in place.
		await establishFindingPolicyEvidence('run-2840-policy');
		await writeTriggerReceipt('run-2840-policy', true, { remark: false });
		const report = await readPrReviewFinalFindingPolicyForReport(
			directory,
			SESSION_ID,
		);
		expect(report).not.toBeNull();
		expect([...(report?.permittedVerdicts ?? [])]).toEqual([
			'REQUEST_CHANGES',
			'INCOMPLETE',
		]);
	});
});
