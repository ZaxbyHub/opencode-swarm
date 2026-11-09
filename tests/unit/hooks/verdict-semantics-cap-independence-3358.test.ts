/**
 * Issue #3358 AC4 cap-independence riders (approved plan R4, added at the
 * Phase 4.5 implementation-review round): the semantics disclosure must
 * survive a SATURATED composition-diagnostic budget, the message must bound
 * at 16 ids with "and N more", and the structured composition field must
 * carry the complete set. The settlement guard must also leave no
 * verdict-settlement receipt behind when it throws.
 *
 * RED against the guard regression (M2) and against a cap-only disclosure;
 * GREEN at the shipped head.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
} from './pr-workflow-gate.test-fixtures.js';

const ITEM_IDS = PR_REVIEW_BASE_DIMENSION_IDS.map(
	(_dimension, index) => `C-${index}`,
);
const lanes = [
	{ laneId: 'lane-1', workflowLane: 'lane-1', reviewItemIds: ITEM_IDS },
];

/** A full-coverage reviewer artifact whose every row is a v1-era mismatch. */
const CONFIRMED_NONE_TEXT = ITEM_IDS.map(
	(itemId) =>
		`[REVIEWED] | ${itemId} | CONFIRMED | STATIC_TRACE_PROVEN | NONE | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer | UNKNOWN | `,
).join('\n');

/**
 * Saturate the shared composition-diagnostic budget (16 entries) with
 * unrelated noise: each newer batch carries one DISTINCT unassigned verdict
 * row, and every such lane contributes its own "contains an unassigned
 * verdict row" diagnostic. Eighteen lanes exceed the cap, evicting the
 * per-lane semantics convenience diagnostic from the capped channel.
 */
async function saturateDiagnostics(): Promise<void> {
	for (let i = 0; i < 18; i += 1) {
		const batchId = `noise-${i}`;
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId, prHeadSha: HEAD_SHA },
		);
		await persistBatch(batchId, 'swarm-pr-review:reviewer', lanes, {
			textOverride: `[REVIEWED] | noise-${i} | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale noise ${i} | probe noise ${i} | reviewer | UNKNOWN | `,
		});
	}
}

function settlementReceipts(): string[] {
	const root = join(tempDir, '.swarm', 'pr-review');
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((runId) =>
			existsSync(join(root, runId, 'verdict-settlement.reviewer.json')),
		)
		.map((runId) => join(runId, 'verdict-settlement.reviewer.json'));
}

describe('semantics-mismatch disclosure cap independence (#3358 AC4, plan R4)', () => {
	beforeEach(setupPrWorkflowGateFixtures);
	afterEach(teardownPrWorkflowGateFixtures);

	test('a saturated diagnostic budget still yields the dedicated clause and no receipt', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId: 'legacy-full', prHeadSha: HEAD_SHA },
		);
		await persistBatch('legacy-full', 'swarm-pr-review:reviewer', lanes, {
			textOverride: CONFIRMED_NONE_TEXT,
		});
		await saturateDiagnostics();
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		// The shared 16-entry diagnostic budget is saturated (18 distinct
		// unassigned-row lanes) and the per-lane semantics CONVENIENCE
		// diagnostic has been evicted by that pressure...
		expect(composed.diagnostics.length).toBe(16);
		expect(
			composed.diagnostics.some((entry) =>
				/earlier verdict semantics/.test(entry),
			),
		).toBe(false);
		// ...yet the structured field still carries the complete mismatch set.
		expect(composed.semanticsMismatchedItemIds).toEqual(ITEM_IDS);
		let message = '(settlement unexpectedly admitted)';
		try {
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain('N-of-M settlement is not attempted');
		expect(message).toMatch(/earlier verdict semantics/i);
		// The dedicated clause fires BEFORE N-of-M admission, so no receipt.
		expect(settlementReceipts()).toEqual([]);
	});

	test('the message names every mismatched id with the dedicated clause (6-id inventory: no overflow)', async () => {
		await establishReviewPrerequisites();
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			lanes,
			{ batchId: 'legacy-overflow', prHeadSha: HEAD_SHA },
		);
		await persistBatch('legacy-overflow', 'swarm-pr-review:reviewer', lanes, {
			textOverride: CONFIRMED_NONE_TEXT,
		});
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		expect(composed.semanticsMismatchedItemIds).toEqual(ITEM_IDS);
		let message = '(settlement unexpectedly admitted)';
		try {
			await assertPrReviewValidationSettled(tempDir, SESSION_ID, 'reviewer');
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// The required inventory here is the six fixed base dimensions, so the
		// 16-id display bound cannot overflow in this fixture; what this leg
		// pins is that the DEDICATED clause (not the generic path) names every
		// mismatched id — the guard-specific marker that the M2 mutant loses.
		expect(message).toContain('N-of-M settlement is not attempted');
		for (const itemId of ITEM_IDS) {
			expect(message).toContain(itemId);
		}
		expect(message.match(/and \d+ more/)).toBeNull();
		// Unmet-by-fixture plan case, disclosed: the "and N more" overflow
		// suffix needs a >16-item required inventory; the gate's reviewer
		// inventory is exactly the six base dimensions in these fixtures.
	});
});
