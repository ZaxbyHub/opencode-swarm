import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	assertPrReviewValidationSettled,
	_test_exports as gateInternals,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from './pr-workflow-gate.test-fixtures.js';

// Verdict-row pipe tolerance (PR-review deadlock fix). The strict verdict
// parsers count pipe fields exactly ([REVIEWED]: 10, [CRITIC]: 6), so prose in
// the trailing free-text fields that contains literal pipes — regex text,
// `,;|`, shell snippets — previously made the whole verdict unparseable and
// dead-ended the reviewer/critic phases exactly like the discovery phase.
// pipeFieldsCapped tail-merges extra separators into the trailing field.

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('verdict row pipe tolerance', () => {
	test('escaped reviewer delimiters round-trip into the canonical digest instead of dropping the row', () => {
		// Regression for issue #2333 item 1: REVIEWED rows now carry a real codec
		// (`\\`, `\|`, `\n`, `\r`) rather than a tail-merge heuristic. This row
		// previously vanished because `\|` still split the raw text.
		const row =
			'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale a\\|b | probe c\\\\d | reviewer line1\\nline2\\rline3';
		const parsed = gateInternals.parseLaneItemVerdicts(
			row,
			['C-0'],
			'reviewer',
		);
		expect(parsed.get('C-0')).toEqual({
			classification: 'CONFIRMED',
			severity: 'HIGH',
			// A legacy ten-field row is normalized at the parse boundary to
			// UNKNOWN / no tags (issue #2383); the digest binds to the
			// NORMALIZED twelve-field view.
			riskImpact: 'UNKNOWN',
			riskTags: [],
			rowDigest: gateInternals.reviewerVerdictRowDigest([
				'[REVIEWED]',
				'C-0',
				'CONFIRMED',
				'STRUCTURALLY_PROVEN',
				'HIGH',
				'YES',
				'file.ts:1',
				'rationale a|b',
				'probe c\\d',
				'reviewer line1\nline2\rline3',
				'UNKNOWN',
				'',
			]),
		});
	});

	test('pipeFieldsCapped preserves all fields exactly when the pipe is trailing', () => {
		// Fidelity-safe shape: extra pipes in the LAST (free-text) field merge
		// back into it; every earlier field is byte-identical.
		const row =
			'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale text | probe | reviewer notes mentioning `,;|` and a | b';
		const capped = gateInternals.pipeFieldsCapped(row, 10);
		expect(capped).toHaveLength(10);
		expect(capped.slice(0, 9)).toEqual(
			row
				.split('|')
				.map((f) => f.trim())
				.slice(0, 9),
		);
		// Fields are pipe-split and trimmed before rejoining, so surrounding
		// whitespace around an embedded pipe is normalized away — the pipe
		// character and field content themselves are preserved.
		expect(capped[9]).toBe('reviewer notes mentioning `,;|` and a|b');
	});

	test('pipeFieldsCapped n=6 [CRITIC] identity: trailing-pipe merge preserves fields 0-4 exactly', () => {
		const row =
			'[CRITIC] | it-1 | UPHELD | HIGH | the gate rejects injection chars | final prose mentioning a | b';
		const capped = gateInternals.pipeFieldsCapped(row, 6);
		expect(capped).toHaveLength(6);
		expect(capped.slice(0, 5)).toEqual(
			row
				.split('|')
				.map((f) => f.trim())
				.slice(0, 5),
		);
		expect(capped[5]).toBe('final prose mentioning a|b');
	});

	test('digest binds to the canonical capped view, stable across re-reads', () => {
		const row =
			'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer notes mentioning a | b';
		// reviewerVerdictRowDigest is what binds critic claims to reviewer rows;
		// its input is the canonical capped field view, so repeated parses of the
		// same retained artifact yield the identical digest (binding holds), and
		// the digest demonstrably follows the canonical view rather than the raw
		// split (a mid-row pipe re-arranges trailing prose; machine fields are
		// unchanged).
		const digestA = gateInternals.reviewerVerdictRowDigest(
			gateInternals.pipeFieldsCapped(row, 10),
		);
		const digestB = gateInternals.reviewerVerdictRowDigest(
			gateInternals.pipeFieldsCapped(row, 10),
		);
		expect(digestA).toBe(digestB);
		expect(digestA).not.toBe(
			gateInternals.reviewerVerdictRowDigest(
				row.split('|').map((field) => field.trim()),
			),
		);
	});

	test('pipeFieldsCapped preserves machine fields when the pipe is mid-row', () => {
		// Documented boundary: a pipe in a NON-trailing prose field re-arranges
		// the trailing prose fields, but the enumerated machine positions
		// (id, classification, severity, file:line) are untouched.
		const row =
			'[REVIEWED] | C-0 | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale mentioning `,;|` inline | probe | reviewer';
		const capped = gateInternals.pipeFieldsCapped(row, 10);
		expect(capped).toHaveLength(10);
		expect(capped[1]).toBe('C-0');
		expect(capped[2]).toBe('CONFIRMED');
		expect(capped[4]).toBe('HIGH');
		expect(capped[6]).toBe('file.ts:1');
	});

	test('feedback four-field parsing retains the legacy capped merge behavior', () => {
		// Issue #2333 hardens only REVIEWED/CRITIC rows. The older four-field
		// families keep the raw capped merge so PR_FEEDBACK parsing does not drift.
		const row =
			'[FEEDBACK-VERIFIED] | F-1 | CONFIRMED | evidence mentioning a | b';
		expect(gateInternals.pipeFieldsCapped(row, 4)).toEqual([
			'[FEEDBACK-VERIFIED]',
			'F-1',
			'CONFIRMED',
			'evidence mentioning a|b',
		]);
	});

	test('production indexing retains both legacy overflow recovery classes', () => {
		// Under the twelve-field contract the fidelity-safe shape is a full
		// canonical row plus ONE extra trailing empty field (issue #2383).
		const fidelitySafe = gateInternals.indexVerdictRows(
			'[REVIEWED] | C-safe | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | SECURITY | ',
			'[REVIEWED]',
		);
		expect(fidelitySafe.recoveries).toEqual([
			{
				marker: '[REVIEWED]',
				itemId: 'C-safe',
				recovery: 'legacy-fidelity-safe',
			},
		]);

		const lossy = gateInternals.indexVerdictRows(
			'[CRITIC] | C-lossy | UPHELD | HIGH | rationale with | a pipe | required change',
			'[CRITIC]',
		);
		expect(lossy.recoveries).toEqual([
			{
				marker: '[CRITIC]',
				itemId: 'C-lossy',
				recovery: 'legacy-lossy',
			},
		]);

		const ordinaryLegacy = gateInternals.indexVerdictRows(
			'[CRITIC] | C-ordinary | UPHELD | HIGH | rationale | required change',
			'[CRITIC]',
		);
		expect(ordinaryLegacy.recoveries).toEqual([]);
	});

	test('a lossy legacy [REVIEWED] row with unescaped rationale pipes is recovered and routed', async () => {
		// INTENT CHANGE (issue #2383): the twelve-field REVIEWED contract ends
		// tail-merge recovery for unescaped mid-row pipes — the merged tail
		// lands in the enum-constrained risk_tags field and can never
		// re-validate. The recoverable shape is now the ESCAPED pipe codec, so
		// the fixture escapes the pipe and the row still authenticates and
		// settles.
		await establishReviewPrerequisites();
		const itemIds = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-pipes',
					workflowLane: 'review-pipes',
					reviewItemIds: itemIds,
				},
			],
			{ batchId: 'review-pipes', prHeadSha: HEAD_SHA },
		);
		// The pipe sits in a MID-row prose field (rationale). Under the
		// twelve-field contract (issue #2383) the pipe must be ESCAPED with the
		// verdict codec (`\|`); authentication then succeeds with the pipe
		// preserved inside the rationale.
		const reviewerRows = itemIds
			.map(
				(id) =>
					`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | regex text mentioning the class \`,;\\|\` inline | probe | reviewer | ORDINARY | `,
			)
			.join('\n');
		await persistBatch(
			'review-pipes',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-pipes', workflowLane: 'review-pipes' }],
			{ textOverride: reviewerRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});

	test('a lossy legacy [CRITIC] row with unescaped rationale pipes is recovered and routed', async () => {
		await establishReviewPrerequisites();
		const itemIds = ['C-0', 'C-1', 'C-2', 'C-3', 'C-4', 'C-5'];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			[
				{
					laneId: 'review-clean',
					workflowLane: 'review-clean',
					reviewItemIds: itemIds,
				},
			],
			{ batchId: 'review-clean', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'review-clean',
			'swarm-pr-review:reviewer',
			[{ laneId: 'review-clean', workflowLane: 'review-clean' }],
			{
				textOverride: itemIds
					.map(
						(id) =>
							`[REVIEWED] | ${id} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale | probe | reviewer | ORDINARY | `,
					)
					.join('\n'),
			},
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			[
				{
					laneId: 'critic-pipes',
					workflowLane: 'critic-pipes',
					reviewItemIds: itemIds,
				},
			],
			{ batchId: 'critic-pipes', prHeadSha: HEAD_SHA },
		);
		const criticRows = itemIds
			.map(
				(id) =>
					`[CRITIC] | ${id} | UPHELD | HIGH | the gate rejects \`,;|\` injection chars | required change spelled out`,
			)
			.join('\n');
		await persistBatch(
			'critic-pipes',
			'swarm-pr-review:critic',
			[{ laneId: 'critic-pipes', workflowLane: 'critic-pipes' }],
			{ textOverride: criticRows },
		);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'critic'),
		).resolves.toMatchObject({ mode: 'PR_REVIEW' });
	});
});
