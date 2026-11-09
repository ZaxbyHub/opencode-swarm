/**
 * Issue #3358 AC4 (trace 3358-3337-3341, collated AC4 / #3358 AC3): a reviewer
 * lane artifact persisted under the PRE-tightening verdict semantics — a
 * `[REVIEWED]` row with status CONFIRMED and severity NONE, which the CURRENT
 * 12-field reviewer schema rejects ("CONFIRMED reviewer severity must not be
 * NONE") — must NOT be silently lost when the reviewer phase is re-composed.
 * The artifact is stored exactly the way `storeLaneOutput` persists lane text
 * today (raw text, `LANE_OUTPUT_SCHEMA_VERSION = 1`, no verdict-semantics
 * marker), so the replay is indistinguishable at the storage layer from a
 * production artifact written before the tightening.
 *
 * Accepted outcomes (the check passes on EITHER):
 *  (a) the claim is still admitted/settled — the artifact is re-parsed under
 *      the verdict semantics it was written with (a version gate), so every
 *      item the legacy row covers stays claimed; or
 *  (b) the composition surfaces an explicit per-claim disclosure that names
 *      the verdict-semantics/version mismatch for the affected item — not
 *      just the generic "items lack an authenticated verdict" settlement
 *      failure.
 *
 * At base neither happens: the live schema rejects the row, the item stays
 * unclaimed, and settlement fails with the generic message (the fail-closed
 * replay documented at pr-review-contract.ts:804-818, reserved to this issue).
 * RED at base, GREEN after the fix.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PrReviewReviewerVerdictFieldsSchema } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	assertPrReviewValidationSettled,
	PR_REVIEW_BASE_DIMENSION_IDS,
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
} from '../hooks/pr-workflow-gate.test-fixtures.js';

/**
 * The 12-field reviewer row as a pre-tightening artifact would carry it: a
 * CONFIRMED classification self-contradicted by severity NONE. Every other
 * field is valid, so the row's only defect is the semantics the CURRENT
 * schema tightened.
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

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
/** The item whose legacy-semantics loss the disclosure leg names. */
const FIRST_ITEM_ID = 'C-0';

describe('issue #3358 AC4: pre-tightening verdict-semantics replay is not silent', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('premise pin: the CURRENT reviewer schema rejects the CONFIRMED/NONE row', () => {
		// GREEN at base (the #3310 tightening). This pin keeps the replay premise
		// honest: if this row ever becomes schema-valid again, the replay test
		// below would flip to outcome (a) for a reason that has nothing to do
		// with verdict-semantics versioning.
		const parsed =
			PrReviewReviewerVerdictFieldsSchema.safeParse(CONFIRMED_NONE_ROW);
		expect(parsed.success).toBe(false);
	});

	test('a stored CONFIRMED/NONE reviewer artifact is either re-admitted or explicitly disclosed on recomposition', async () => {
		await establishReviewPrerequisites();
		// The legacy-semantics artifact: persisted through the production lane
		// store path (recordPendingDelegation + storeLaneOutput + completed
		// transition) with the pre-tightening CONFIRMED|NONE row text. The
		// storage layer adds no verdict-semantics marker, exactly like a real
		// artifact written before the tightening.
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

		// Outcome (a): every item the legacy row covers is still claimed — the
		// artifact was re-parsed under the semantics it was written with.
		const allClaimed = ITEM_IDS.every((itemId) => composed.claims.has(itemId));
		if (allClaimed) return;

		// Outcome (b): the composition must disclose the loss per claim, naming
		// the verdict-semantics/version mismatch for the affected item. The
		// disclosure is read from the surfaces composition owns — the settle
		// rejection (which embeds composition diagnostics) and the composition's
		// own diagnostics channel.
		let settleMessage = '(settlement unexpectedly admitted)';
		try {
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		} catch (error) {
			settleMessage = error instanceof Error ? error.message : String(error);
		}
		const disclosureSurface = `${settleMessage}\n${composed.diagnostics.join('\n')}`;
		expect(disclosureSurface).toMatch(
			/semantic|version/i,
			'a pre-tightening CONFIRMED/NONE reviewer artifact was dropped without a verdict-semantics/version disclosure: the composition left every item unclaimed and settlement named only the generic missing-verdict failure',
		);
		expect(disclosureSurface).toContain(FIRST_ITEM_ID);
	});
});
