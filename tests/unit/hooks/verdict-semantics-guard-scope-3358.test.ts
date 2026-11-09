/**
 * Issue #3358 AC4 rider tests (plan T2): the earlier-semantics settlement
 * guard blocks only mismatches that are still UNCLAIMED. Composition is
 * newest-valid-claim-wins across batches, so a claimed item with a stale
 * extra mismatched row must never block N-of-M admission, and a partial
 * re-run that supplies a valid claim settles even while the old mismatched
 * artifact stays in the window. An unresolved mismatch still throws the
 * dedicated clause (covered by frozen C4) and never reaches N-of-M.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract.js';
import {
	_test_exports,
	assertPrReviewValidationSettled,
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

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const lanes = [
	{ laneId: 'lane-1', workflowLane: 'lane-1', reviewItemIds: ITEM_IDS },
];

function reviewerText(severities: Record<string, string>): string {
	return ITEM_IDS.map(
		(itemId) =>
			`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | ${severities[itemId] ?? 'HIGH'} | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
	).join('\n');
}

const CONFIRMED_NONE_TEXT = ITEM_IDS.map(
	(itemId) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
).join('\n');

describe('semantics-mismatch settlement guard scope (#3358 AC4, plan T2)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a claimed item with an older mismatched row does not enter the mismatch set', async () => {
		await establishReviewPrerequisites();
		// Newest batch carries the v1-era rows for every item (mismatched)...
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'legacy-reviewer',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch('legacy-reviewer', 'swarm-pr-review:reviewer', lanes, {
			textOverride: CONFIRMED_NONE_TEXT,
		});
		// ...and an even newer batch supplies valid v2 rows for every item.
		const valid = Object.fromEntries(ITEM_IDS.map((id) => [id, 'HIGH']));
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'valid-reviewer',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch('valid-reviewer', 'swarm-pr-review:reviewer', lanes, {
			textOverride: reviewerText(valid),
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// Every item is claimed by the newer valid row...
		expect(composed.unclaimed).toEqual([]);
		// ...so settlement succeeds regardless of the stale mismatched batch.
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toBeDefined();
	});

	test('a partial re-run covering the mismatched items settles the phase', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'legacy-partial',
				prHeadSha: HEAD_SHA,
			},
		);
		// First artifact: mismatched rows for the FIRST HALF only.
		await persistBatch(
			'legacy-partial',
			'swarm-pr-review:reviewer',
			[{ ...lanes[0], reviewItemIds: ITEM_IDS.slice(0, 3) }],
			{ textOverride: CONFIRMED_NONE_TEXT.split('\n').slice(0, 3).join('\n') },
		);
		// Re-run: a valid full-coverage artifact (the exact recovery path the
		// dedicated error tells the operator to take).
		const valid = Object.fromEntries(ITEM_IDS.map((id) => [id, 'HIGH']));
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'valid-partial',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch('valid-partial', 'swarm-pr-review:reviewer', lanes, {
			textOverride: reviewerText(valid),
		});
		_test_exports.resetTrackedStateCache();
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).resolves.toBeDefined();
	});

	test('an unresolved mismatch blocks with the dedicated clause even when another item is N-of-M-admissible', async () => {
		await establishReviewPrerequisites();
		// Item C-1: a valid claim. Every OTHER item: ONE mismatched row each
		// (a single row per item is what the classifier keys on).
		const validC1 =
			'[REVIEWED] | C-1 | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale C-1 | probe C-1 | reviewer | UNKNOWN | ';
		const mismatchedOthers = ITEM_IDS.filter((id) => id !== 'C-1')
			.map(
				(itemId) =>
					`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
			)
			.join('\n');
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{
				batchId: 'mixed-reviewer',
				prHeadSha: HEAD_SHA,
			},
		);
		await persistBatch('mixed-reviewer', 'swarm-pr-review:reviewer', lanes, {
			textOverride: `${validC1}\n${mismatchedOthers}`,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.claims.has('C-1')).toBe(true);
		expect(composed.unclaimed).toContain('C-0');
		await expect(
			assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer'),
		).rejects.toThrow(/earlier verdict semantics/);
	});
});
