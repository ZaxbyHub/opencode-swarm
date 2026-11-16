import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PR_REVIEW_TRIGGER_DEFINITIONS } from '../../../src/background/pr-review-trigger-contract.js';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeCompletePrWorkflow } from '../../../src/tools/complete-pr-workflow.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Issue #3098 check C5 (DISCRIMINATING). `complete_pr_workflow`'s terminalReport
 * lacks bounded findings and coverage-degradation summaries: an operator
 * reading the terminal report sees the verdict but neither the finding counts
 * nor the disclosed degradation that constrained it. The fix captures both
 * BEFORE the terminal state clear (the read-before-clear discipline already
 * used for the coverage/verdict-settlement reads).
 *
 * Frozen field-name contract (documented for the implementer):
 * - `terminal_report.findings_summary` = `{ total: number, by_severity:
 *   Record<string, number> }` — count-based axes over FinalPolicyFinding
 *   severity (CRITICAL/HIGH/MEDIUM/LOW/INFO/NONE), values that can never be
 *   the string 'CLEAN' (r04-nonempty-registered.test.ts pins that the
 *   terminal_report JSON never contains the literal CLEAN).
 * - `terminal_report.coverage_degradations` = bounded array of the disclosed
 *   trigger-receipt coverage degradations (length >= 1 when the run's receipt
 *   carries one).
 *
 * Scenario: the full finding-policy evidence chain (recipe from
 * tests/unit/hooks/issue-2840-degraded-disclosure-completion.test.ts, itself
 * from write-pr-review-artifact-policy-integration.test.ts) — one DISPROVED
 * candidate, five CONFIRMED HIGH critic-upheld findings — plus a v2
 * trigger-eval receipt overwritten with one dead-family coverage degradation.
 * Completion with REQUEST_CHANGES succeeds at base; only the new summary
 * fields are absent.
 */

const SESSION_ID = PR_ARTIFACT_SESSION_ID;
const HEAD_SHA = PR_ARTIFACT_HEAD_SHA;
const RUN_ID = 'c5-terminal-summaries-run';
let directory = '';

const ORIGINALS = {
	head: gateInternals.resolveCurrentGitHead,
	headAsync: gateInternals.resolveCurrentGitHeadAsync,
	revision: gateInternals.resolvePrWorkflowRevisionDigest,
	clean: gateInternals.resolveIsWorkingTreeClean,
	cleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('c5-terminal-summaries-');
	// The ledger writer behind the fixtures asserts a project root.
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

/** Full finding-policy evidence chain: one DISPROVED + five CONFIRMED HIGH. */
async function establishFindingsAndDegradation(): Promise<void> {
	await establishPrReviewPrerequisites(directory, RUN_ID);
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
				laneId: `${RUN_ID}-rv`,
				workflowLane: `${RUN_ID}-rv`,
				reviewItemIds: [...findingIds],
			},
		],
		{ batchId: `${RUN_ID}-rv`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${RUN_ID}-rv`,
		'swarm-pr-review:reviewer',
		[{ laneId: `${RUN_ID}-rv`, workflowLane: `${RUN_ID}-rv` }],
		{ textOverride: reviewerRows },
	);
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'critic',
		[
			{
				laneId: `${RUN_ID}-cr`,
				agent: 'critic',
				workflowLane: `${RUN_ID}-cr`,
				reviewItemIds: findingIds.slice(1),
			},
		],
		{ batchId: `${RUN_ID}-cr`, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		`${RUN_ID}-cr`,
		'swarm-pr-review:critic',
		[{ laneId: `${RUN_ID}-cr`, workflowLane: `${RUN_ID}-cr` }],
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
				run_id: RUN_ID,
				pr_head_sha: HEAD_SHA,
				boundary,
				records,
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		expect(raw, `${RUN_ID} ${boundary} artifact write must succeed`).toContain(
			'"success": true',
		);
	}
	// Overwrite this run's bound trigger-eval receipt with one disclosed
	// dead-family coverage degradation (the run's path is already bound, so
	// only the file is replaced — remark: false).
	await writeDegradedTriggerReceipt();
}

/**
 * Mirrors writeTriggerReceipt(runId, true, { remark: false }) from the #2840
 * suite, with one correctness fix required for a FULL completion: the rows
 * must cite the indexed micro batches/lanes establishPrReviewPrerequisites
 * actually created (micro-<index> / micro-lane-<index>), or the completion
 * gate's micro-lane provenance check blocks the run.
 */
async function writeDegradedTriggerReceipt(): Promise<void> {
	const rows = PR_REVIEW_TRIGGER_DEFINITIONS.map((definition, index) => ({
		trigger_id: definition.id,
		scope: definition.scope,
		trigger_row: definition.trigger_row,
		micro_lane: definition.micro_lane,
		result: 'MATCHED' as const,
		evidence: `fixture evidence for ${definition.id}`,
		source_batch_id: `micro-${index}`,
		source_lane_id: `micro-lane-${index}`,
	}));
	const coverage_degradations = [
		{
			trigger_id: rows[0]!.trigger_id,
			source_batch_id: rows[0]!.source_batch_id,
			source_lane_id: rows[0]!.source_lane_id,
			reason:
				'liveness-terminal dead family: lane settled stale with typed liveness class (presumed host abandonment), no retained artifact; family disclosed unattested',
		},
	];
	const triggerRelative = path.join('pr-review', RUN_ID, 'trigger-eval.json');
	const triggerAbsolute = path.join(directory, '.swarm', triggerRelative);
	await fs.mkdir(path.dirname(triggerAbsolute), { recursive: true });
	await fs.writeFile(
		triggerAbsolute,
		JSON.stringify({
			schema_version: 2,
			run_id: RUN_ID,
			pr_head_sha: HEAD_SHA,
			base_ref: 'origin/main',
			base_sha: 'def456',
			evaluated_at: '2026-10-11T00:00:00.000Z',
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
}

interface TerminalReport {
	kind: string;
	[key: string]: unknown;
}

describe('complete_pr_workflow terminal summaries (issue #3098)', () => {
	test('a findings-bearing degraded run reports bounded findings and degradation summaries', async () => {
		await establishFindingsAndDegradation();
		// Control: the scenario itself completes at base — REQUEST_CHANGES stays
		// verdict-permitted under a disclosed degradation (issue #2840).
		const raw = await executeCompletePrWorkflow(
			{
				mode: 'PR_REVIEW',
				pr_head_sha: HEAD_SHA,
				report_verdict: 'REQUEST_CHANGES',
			},
			directory,
			{ sessionID: SESSION_ID },
		);
		const result = JSON.parse(raw) as {
			success: boolean;
			status?: string;
			terminal_report?: TerminalReport;
		};
		expect(result.success).toBe(true);
		expect(result.status).toBe('completed');
		const terminalReport = result.terminal_report;
		expect(terminalReport).toBeDefined();
		expect(terminalReport!.kind).toBe('COMPLETE');

		// --- Findings summary (frozen contract: findings_summary with count
		// axes that can never render as the string CLEAN). ---
		const findingsSummary = terminalReport!.findings_summary as
			| { total?: number; by_severity?: Record<string, number> }
			| undefined;
		expect(findingsSummary).toBeDefined();
		expect(findingsSummary!.total).toBeGreaterThan(0);
		const severityTotal = Object.values(
			findingsSummary!.by_severity ?? {},
		).reduce((sum, count) => sum + count, 0);
		expect(severityTotal).toBeGreaterThan(0);

		// --- Coverage degradation summary (frozen contract: bounded
		// coverage_degradations array; this run's receipt discloses one). ---
		const degradations = terminalReport!.coverage_degradations as
			| unknown[]
			| undefined;
		expect((degradations ?? []).length).toBeGreaterThanOrEqual(1);

		// --- Shape guard (r04 pins the quoted form; the stricter bare-literal
		// form also holds and forbids sentinel-bearing values like CLEAN-REVIEW
		// in the new fields). ---
		expect(JSON.stringify(terminalReport)).not.toContain('CLEAN');
	}, 60_000);
});
