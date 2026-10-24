import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PrReviewReviewerVerdictFieldsSchema } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	assertPrReviewValidationSettled,
	PR_REVIEW_BASE_DIMENSION_IDS,
	recordPrReviewValidationBatch,
} from '../../../src/hooks/pr-workflow-gate.js';
import { validateReviewerVerdictFields } from '../../../src/pr-review/legacy-transcript-adapter.js';
import {
	establishReviewPrerequisites,
	HEAD_SHA,
	persistBatch,
	SESSION_ID,
	setupPrWorkflowGateFixtures,
	teardownPrWorkflowGateFixtures,
	tempDir,
} from '../hooks/pr-workflow-gate.test-fixtures.js';

/**
 * Issue #3310 AC11 (reviewer lane quarantine — CONFIRMED/NONE grammar hole): a
 * CONFIRMED reviewer verdict carrying severity NONE is self-contradictory and
 * must fail the 12-field reviewer schema (naming the severity position or the
 * CONFIRMED classification), and therefore fail the adapter. RED at base,
 * GREEN after the fix (the base superRefine only forces NONE for DISPROVED,
 * so a CONFIRMED/NONE row is schema-valid and admits today).
 */

const CONFIRMED_NONE_ROW = [
	'[REVIEWED]',
	'C-1',
	'CONFIRMED',
	'STATIC_TRACE_PROVEN',
	'NONE',
	'YES',
	'a.ts:1',
	'rationale long',
	'probe text',
	'notes',
	'UNKNOWN',
	'',
];

describe('reviewer CONFIRMED/NONE row fails the grammar (issue #3310 AC11)', () => {
	test('the reviewer schema rejects a CONFIRMED verdict with severity NONE', () => {
		const parsed =
			PrReviewReviewerVerdictFieldsSchema.safeParse(CONFIRMED_NONE_ROW);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			const issues = parsed.error.issues;
			expect(
				issues.some(
					(issue) => issue.path.includes(4) || /CONFIRMED/i.test(issue.message),
				),
			).toBe(true);
		}
	});

	test('validateReviewerVerdictFields returns null for the CONFIRMED/NONE row', () => {
		expect(validateReviewerVerdictFields(CONFIRMED_NONE_ROW)).toBeNull();
	});
});

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);

/**
 * Issue #3336 AC1 — the durable replay contract, pinned end to end through
 * the composition path. Lane artifacts persist raw text (no write-time row
 * validation), so rows written under an OLDER schema re-parse under the LIVE
 * one. Both directions are pinned here; a future change to either replay
 * semantic (a version gate, a silent accept, a different failure shape)
 * turns the corresponding test red. GREEN at base by design — these are
 * pins, and each names the mutation that kills it in 08-test-results.md.
 */
describe('issue #3336 AC1: deterministic replay of pre-upgrade artifacts (pins)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('PIN (fail-closed): a pre-upgrade CONFIRMED+NONE reviewer artifact leaves every item unclaimed and blocks settlement', async () => {
		// Killed by reverting the CONFIRMED/NONE superRefine branch
		// (pr-review-contract.ts): the rows would then claim and the settle
		// assert would stop rejecting.
		await establishReviewPrerequisites();
		const lanes = [
			{ laneId: 'lane-1', workflowLane: 'lane-1', reviewItemIds: ITEM_IDS },
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'preupgrade-reviewer',
				prHeadSha: HEAD_SHA,
			},
		);
		const preupgradeText = ITEM_IDS.map(
			(itemId) =>
				`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer`,
		).join('\n');
		await persistBatch(
			'preupgrade-reviewer',
			'swarm-pr-review:reviewer',
			lanes,
			{
				textOverride: preupgradeText,
			},
		);
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.claims.size).toBe(0);
		expect(composed.unclaimed).toEqual(ITEM_IDS);
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow('items lack an authenticated verdict');
	});

	test('PIN (accepting): a pre-upgrade UPHELD|LOW critic artifact becomes claimable once its reviewer row validates', async () => {
		// Killed by re-narrowing the UPHELD superRefine to
		// CRITICAL/HIGH/MEDIUM (the pre-#3310 shape): the critic rows would
		// stop claiming and the settle assert would reject.
		await establishReviewPrerequisites();
		// Reviewer settles every item at LOW severity, so an UPHELD|LOW critic
		// row is rank-valid under validateCriticVerdictFields.
		const reviewerLanes = [
			{ laneId: 'rv-low', workflowLane: 'rv-low', reviewItemIds: ITEM_IDS },
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			reviewerLanes,
			{ batchId: 'rv-low', prHeadSha: HEAD_SHA },
		);
		const reviewerText = ITEM_IDS.map(
			(id) =>
				`[REVIEWED] | ${id} | CONFIRMED | STATIC_TRACE_PROVEN | LOW | YES | file.ts:1 | rationale ${id} | probe ${id} | reviewer`,
		).join('\n');
		await persistBatch('rv-low', 'swarm-pr-review:reviewer', reviewerLanes, {
			textOverride: reviewerText,
		});
		// A pre-upgrade critic artifact: the pre-#3310 read schema rejected
		// UPHELD at LOW, but nothing validates rows at write time, so the
		// artifact persists and the live (widened) schema now admits it.
		const criticLanes = [
			{
				laneId: 'critic-low',
				workflowLane: 'critic-low',
				reviewItemIds: ITEM_IDS,
				agent: 'critic',
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'critic',
			criticLanes,
			{ batchId: 'critic-low', prHeadSha: HEAD_SHA },
		);
		const criticText = ITEM_IDS.map(
			(id) =>
				`[CRITIC] | ${id} | UPHELD | LOW | reason long enough | required change text`,
		).join('\n');
		await persistBatch('critic-low', 'swarm-pr-review:critic', criticLanes, {
			textOverride: criticText,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'critic',
		);
		expect(composed.claims.size).toBe(ITEM_IDS.length);
		expect(composed.unclaimed).toEqual([]);
	});
});
