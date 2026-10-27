// Issue #2906 — the findings-writer authority cross-check for order_agreement
// (plan-critic round-1 blocker): a model-supplied label may neither contradict
// the composed reviewer verdicts nor assert affirmative agree/disagree with no
// composed authority. Runs the REAL writer over a composed counterbalanced
// world, at the post_reviewer boundary where the field actually lands.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import {
	_test_exports,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
	resolvePrReviewWriterRunId,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeWritePrReviewArtifact } from '../../../src/tools/write-pr-review-artifact.js';
import {
	establishPrReviewPrerequisites,
	persistPrReviewBatch,
} from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'write-pr-review-artifact';
const HEAD_SHA = 'abc123';
const REVISION_DIGEST = 'revision-1';
let directory = '';

const originalResolveCurrentGitHead = _test_exports.resolveCurrentGitHead;
const originalResolveCurrentGitHeadAsync =
	_test_exports.resolveCurrentGitHeadAsync;
const originalResolvePrWorkflowRevisionDigest =
	_test_exports.resolvePrWorkflowRevisionDigest;
const originalResolveIsWorkingTreeClean =
	_test_exports.resolveIsWorkingTreeClean;
const originalResolveIsWorkingTreeCleanAsync =
	_test_exports.resolveIsWorkingTreeCleanAsync;

const INVENTORY = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_lane, index) => `C-${index}`,
);

const reviewedRow = (id: string, severity: string): string =>
	`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | ${severity} | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer | ORDINARY | `;

async function reviewerPass(
	batchId: string,
	severities: Record<string, string>,
): Promise<void> {
	await recordPrReviewValidationBatch(
		directory,
		SESSION_ID,
		'reviewer',
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: `${batchId}-lane`,
				reviewItemIds: INVENTORY,
			},
		],
		{ batchId, prHeadSha: HEAD_SHA },
	);
	await persistPrReviewBatch(
		directory,
		batchId,
		'swarm-pr-review:reviewer',
		[{ laneId: `${batchId}-lane`, workflowLane: `${batchId}-lane` }],
		{
			textOverride: INVENTORY.map((id) =>
				reviewedRow(id, severities[id] ?? 'HIGH'),
			).join('\n'),
		},
	);
}

async function writeBoundary(
	runId: string,
	boundary: 'post_explorer' | 'post_reviewer',
	records: ReadonlyArray<Record<string, unknown>>,
): Promise<string> {
	return executeWritePrReviewArtifact(
		{
			kind: 'findings',
			run_id: runId,
			pr_head_sha: HEAD_SHA,
			boundary,
			records: records.map((record) => ({ ...record })),
		},
		directory,
		{ sessionID: SESSION_ID },
	);
}

const explorerRecord = (id: string) => ({
	finding_id: id,
	status: 'PENDING' as const,
	file_line: 'src/index.ts:1',
	evidence: `candidate evidence ${id}`,
	next_action: 'route_to_reviewer' as const,
	// The post_explorer records must match the candidate-declared severity
	// (the fixture's default candidate severity is HIGH).
	severity: 'HIGH' as const,
});

const reviewerRecord = (id: string, over: Record<string, unknown> = {}) => ({
	finding_id: id,
	status: 'CONFIRMED' as const,
	file_line: 'src/index.ts:1',
	evidence: `reviewer evidence ${id}`,
	// The fixture's candidates are HIGH; the writer requires HIGH CONFIRMED
	// findings to route to the critic and the severity to match the composed
	// verdict (C-0's composed severity is MEDIUM only in the flip world).
	next_action: 'route_to_critic' as const,
	severity: 'HIGH' as const,
	risk_impact: 'ORDINARY' as const,
	risk_tags: [] as string[],
	...over,
});

beforeEach(async () => {
	directory = canonicalMkdtemp('order-agreement-writer-2906-');
	_test_exports.resetTrackedStateCache();
	_test_exports.resolveCurrentGitHead = () => HEAD_SHA;
	_test_exports.resolvePrWorkflowRevisionDigest = () => REVISION_DIGEST;
	_test_exports.resolveIsWorkingTreeClean = () => true;
	_test_exports.resolveCurrentGitHeadAsync = async () => HEAD_SHA;
	_test_exports.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	_test_exports.resolveCurrentGitHead = originalResolveCurrentGitHead;
	_test_exports.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	_test_exports.resolvePrWorkflowRevisionDigest =
		originalResolvePrWorkflowRevisionDigest;
	_test_exports.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
	_test_exports.resolveIsWorkingTreeCleanAsync =
		originalResolveIsWorkingTreeCleanAsync;
	_test_exports.resetTrackedStateCache();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('order_agreement authority cross-check (issue #2906, plan R1)', () => {
	test('contradictory, correct, and absent labels at the post_reviewer boundary', async () => {
		await establishPrReviewPrerequisites(directory, 'oa-run');
		const runId = await resolvePrReviewWriterRunId(directory, SESSION_ID);
		expect(runId).toBe('oa-run');
		// Ladder order: the explorer boundary is written BEFORE any reviewer
		// pass exists, so there is no composed order authority yet and an
		// unlabelled pre-reviewer row is legal (the legacy shape).
		const explorerWrite = await writeBoundary(
			runId,
			'post_explorer',
			INVENTORY.map(explorerRecord),
		);
		expect(explorerWrite).toContain('"success": true');
		// Pass A: everything HIGH. Pass B: C-0 flips to MEDIUM (order-unstable),
		// everything else HIGH (order-stable).
		await reviewerPass('oa-w-a', {});
		await reviewerPass('oa-w-b', { 'C-0': 'MEDIUM' });
		// post_reviewer must exactly cover the discovered inventory; C-0's
		// composed severity is MEDIUM (severity-dependent disposition: a MEDIUM
		// finding reports, only HIGH/CRITICAL route to the critic).
		const fullCoverage = (c0Over: Record<string, unknown>, agree = true) => [
			reviewerRecord('C-0', {
				severity: 'MEDIUM' as const,
				next_action: 'report' as const,
				...c0Over,
			}),
			...INVENTORY.slice(1).map((id) =>
				reviewerRecord(id, agree ? { order_agreement: 'agree' } : {}),
			),
		];

		// Spoof: model claims 'agree' where composition says 'disagree'. The
		// message is JSON-escaped inside the failure envelope, so anchor on the
		// stable unescaped fragments.
		const spoof = await writeBoundary(
			runId,
			'post_reviewer',
			fullCoverage({ order_agreement: 'agree' }),
		);
		expect(spoof).toContain('order_agreement for C-0');
		expect(spoof).toContain('disagree');

		// Spoof: 'single' is still a contradiction when authority exists.
		const wrongSingle = await writeBoundary(
			runId,
			'post_reviewer',
			fullCoverage({ order_agreement: 'single' }),
		);
		expect(wrongSingle).toContain('order_agreement for C-0');
		expect(wrongSingle).toContain('disagree');

		// Review finding F-01: OMITTING the label on a composed 'disagree'
		// finding is the spoof that let the order-unstable marker and its
		// count be suppressed. An absent label is now a contradiction against
		// composed 'disagree', exactly like a contradicting value.
		const omitted = await writeBoundary(
			runId,
			'post_reviewer',
			fullCoverage({}, false),
		);
		expect(omitted).toContain('order_agreement for C-0');
		expect(omitted).toContain('disagree');

		// Correct labels: C-0 disagree, siblings agree — accepted.
		const correct = await writeBoundary(
			runId,
			'post_reviewer',
			fullCoverage({ order_agreement: 'disagree' }),
		);
		expect(correct).toContain('"success": true');
	});

	test('an affirmative label with single-pass authority is a contradiction, not an unbacked pass', async () => {
		await establishPrReviewPrerequisites(directory, 'oa-run-2');
		const runId = await resolvePrReviewWriterRunId(directory, SESSION_ID);
		// Pass A covers the full inventory (the phase settles on one pass); no
		// second pass runs, so every composed authority is 'single'. A
		// single-item 'single' inventory cannot yield an unbacked id through
		// the real writer (exact-cover + records-match reject foreign ids
		// first), so the reachable spoof is an affirmative 'agree' against
		// 'single' authority.
		await writeBoundary(runId, 'post_explorer', INVENTORY.map(explorerRecord));
		await reviewerPass('oa-w2-a', {});
		const spoof = await writeBoundary(
			runId,
			'post_reviewer',
			INVENTORY.map((id) =>
				reviewerRecord(id, id === 'C-1' ? { order_agreement: 'agree' } : {}),
			),
		);
		expect(spoof).toContain('order_agreement for C-1');
		expect(spoof).toContain('single');

		// Absent labels stay allowed (legacy shape, pre-#2906 flows) — the
		// rejected spoof persisted nothing, so this boundary commits cleanly.
		const absent = await writeBoundary(
			runId,
			'post_reviewer',
			INVENTORY.map((id) => reviewerRecord(id)),
		);
		expect(absent).toContain('"success": true');
	});

	test('unbacked affirmative labels are rejected before any reviewer phase composes', async () => {
		// Plan D5 arm: a supplied 'agree'/'disagree' with NO composed value for
		// that id must fail closed. The reachable route through the real writer
		// is a post_explorer write carrying order_agreement BEFORE any
		// reviewer batch exists — the authoritative map is empty, so any
		// affirmative label is unbacked.
		await establishPrReviewPrerequisites(directory, 'oa-run-3');
		const runId = await resolvePrReviewWriterRunId(directory, SESSION_ID);
		const unbacked = await writeBoundary(
			runId,
			'post_explorer',
			INVENTORY.map(explorerRecord).map((record) => ({
				...record,
				order_agreement: 'agree' as const,
			})),
		);
		expect(unbacked).toContain('no composed reviewer authority');
		// 'single' is the allowed legacy-shaped value with no authority.
		const singleNoAuthority = await writeBoundary(
			runId,
			'post_explorer',
			INVENTORY.map(explorerRecord).map((record) => ({
				...record,
				order_agreement: 'single' as const,
			})),
		);
		expect(singleNoAuthority).toContain('"success": true');
	});

	test('a contradictory label at the post_critic boundary is rejected', async () => {
		// Plan round-2 blocker-1 arm: the authority check runs on EVERY
		// invocation supplying the field — post_critic writes pass through the
		// same general findings path, so a model-supplied contradiction at
		// that boundary fails closed too.
		await establishPrReviewPrerequisites(directory, 'oa-run-4');
		const runId = await resolvePrReviewWriterRunId(directory, SESSION_ID);
		await writeBoundary(runId, 'post_explorer', INVENTORY.map(explorerRecord));
		await reviewerPass('oa-w4-a', {});
		await reviewerPass('oa-w4-b', { 'C-0': 'MEDIUM' });
		const reviewerWrite = await writeBoundary(runId, 'post_reviewer', [
			reviewerRecord('C-0', {
				severity: 'MEDIUM' as const,
				next_action: 'report' as const,
				order_agreement: 'disagree',
			}),
			...INVENTORY.slice(1).map((id) =>
				reviewerRecord(id, { order_agreement: 'agree' }),
			),
		]);
		expect(reviewerWrite).toContain('"success": true');
		// Critic batch over the critic-routed (HIGH) items so the critic phase
		// settles; then a post_critic write carrying a spoofed label.
		const criticItems = INVENTORY.slice(1);
		await recordPrReviewValidationBatch(
			directory,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'oa-w4-critic',
					agent: 'critic',
					workflowLane: 'oa-w4-critic',
					reviewItemIds: criticItems,
				},
			],
			{ batchId: 'oa-w4-c', prHeadSha: HEAD_SHA },
		);
		await persistPrReviewBatch(
			directory,
			'oa-w4-c',
			'swarm-pr-review:critic',
			[{ laneId: 'oa-w4-critic', workflowLane: 'oa-w4-critic' }],
			{
				textOverride: criticItems
					.map(
						(id) =>
							`[CRITIC] | ${id} | UPHELD | HIGH | reason ${id} | change ${id}`,
					)
					.join('\n'),
			},
		);
		const postCriticSpoof = await writeBoundary(runId, 'post_critic', [
			reviewerRecord('C-0', {
				severity: 'MEDIUM' as const,
				next_action: 'report' as const,
				order_agreement: 'agree',
			}),
			...criticItems.map((id) =>
				reviewerRecord(id, {
					next_action: 'report' as const,
					order_agreement: 'agree',
					critic_status: 'UPHELD' as const,
				}),
			),
		]);
		expect(postCriticSpoof).toContain('order_agreement for C-0');
		expect(postCriticSpoof).toContain('disagree');
	});

	test('order_agreement participates in the replay-identity key (review F-08c)', async () => {
		// A re-submission whose ONLY delta is the order_agreement label must NOT
		// be an exact replay of the already-persisted boundary — the label
		// changes the published report (order-unstable markers and counts), so
		// `canonicalFindingRecords` folds it into the identity key. Both label
		// shapes are individually LEGAL against the single-pass composed
		// authority ('single': absent is the legacy shape, and 'single' matches
		// the composed value), so the rejection can only come from the
		// replay-identity comparison, not from the authority cross-check.
		await establishPrReviewPrerequisites(directory, 'oa-run-replay');
		const runId = await resolvePrReviewWriterRunId(directory, SESSION_ID);
		await writeBoundary(runId, 'post_explorer', INVENTORY.map(explorerRecord));
		// Single reviewer pass: every item's composed authority is 'single'.
		await reviewerPass('oa-rp-a', {});
		const unlabelled = INVENTORY.map((id) => reviewerRecord(id));
		const first = await writeBoundary(runId, 'post_reviewer', unlabelled);
		expect(first).toContain('"success": true');
		// The only delta is the added order_agreement: 'single' label.
		const relabelled = unlabelled.map((record) => ({
			...record,
			order_agreement: 'single' as const,
		}));
		const relabelledWrite = await writeBoundary(
			runId,
			'post_reviewer',
			relabelled,
		);
		expect(relabelledWrite).toContain('"success": false');
		expect(relabelledWrite).toContain(
			'an exact replay of the already-persisted',
		);
		// Control: the ORIGINAL records replay exactly and stay idempotent.
		const control = await writeBoundary(runId, 'post_reviewer', unlabelled);
		expect(control).toContain('"success": true');
		expect(control).toContain('"replayed": true');
	});
});
