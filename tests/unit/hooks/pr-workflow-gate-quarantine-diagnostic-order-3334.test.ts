import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports,
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
} from './pr-workflow-gate.test-fixtures.js';

/**
 * Issue #3334 AC3 — while the composition diagnostic cap (16) is under
 * pressure, the lane-voiding "unassigned verdict row" diagnostic must stay
 * ahead of quarantine diagnostics: it must never be the one dropped.
 *
 * Scenario: four reviewer batches (recorded oldest-first; the composition
 * scan is newest-first). The three NEWEST batches carry 16 lanes total whose
 * artifacts each contain one illegal-arity stray row (one aggregated
 * quarantine diagnostic per lane). The OLDEST batch carries one lane whose
 * artifact is a legal-arity 12-field row naming an UNASSIGNED id — the
 * lane-voiding diagnostic, scanned last. At base the 16 quarantine
 * diagnostics fill the cap first and the unassigned-row diagnostic is
 * silently dropped (proven RED by frozen check C3); after the fix the
 * quarantine diagnostics flush after the integrity diagnostics, so the
 * unassigned-row diagnostic survives.
 */

const STRAY_LANES = 16;

beforeEach(setupPrWorkflowGateFixtures);
afterEach(teardownPrWorkflowGateFixtures);

describe('issue #3334 AC3: unassigned-row diagnostic outranks quarantine noise under cap pressure', () => {
	test('the lane-voiding diagnostic survives 16 quarantine diagnostics filling the cap', async () => {
		await establishReviewPrerequisites();
		const itemIds = PR_REVIEW_BASE_DIMENSION_IDS.map(
			(_dimension, index) => `C-${index}`,
		);

		// Oldest batch: the unassigned-row lane, scanned LAST.
		const unassignedLanes = [
			{
				laneId: 'lane-unassigned',
				workflowLane: 'lane-unassigned',
				reviewItemIds: ['C-0'],
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			unassignedLanes,
			{ batchId: 'batch-oldest', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'batch-oldest',
			'swarm-pr-review:reviewer',
			unassignedLanes,
			{
				textOverride:
					'[REVIEWED] | C-unassigned | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			},
		);

		// Newer batches: 16 quarantining lanes total, scanned FIRST. Lane
		// ownership is disjoint within each batch (reviewer lanes require
		// non-empty review_item_ids; items may repeat across batches).
		let laneIndex = 0;
		for (const [batchSeq, laneCount] of [
			[1, 6],
			[2, 6],
			[3, 4],
		] as const) {
			const lanes = [];
			for (let i = 0; i < laneCount; i++) {
				laneIndex += 1;
				lanes.push({
					laneId: `lane-q-${laneIndex}`,
					workflowLane: `lane-q-${laneIndex}`,
					reviewItemIds: [itemIds[i] ?? 'C-0'],
				});
			}
			const batchId = `batch-q-${batchSeq}`;
			await recordPrReviewValidationBatch(
				tempDir,
				SESSION_ID,
				'reviewer',
				lanes,
				{
					batchId,
					prHeadSha: HEAD_SHA,
				},
			);
			for (const lane of lanes) {
				const index = Number(lane.laneId.split('-').pop());
				await persistBatch(batchId, 'swarm-pr-review:reviewer', [lane], {
					textOverride: `[REVIEWED] | stray-${index} | APPROVED | looks fine`,
				});
			}
		}
		expect(laneIndex).toBe(STRAY_LANES);

		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		const unassignedDiagnostic = composed.diagnostics.find((line: string) =>
			line.includes('contains an unassigned verdict row'),
		);
		expect(unassignedDiagnostic).toBeDefined();
	});

	test('when the budget allows, quarantine diagnostics still appear — AFTER the lane-voiding diagnostic', async () => {
		// The cap-pressure scenario above legitimately drops ALL quarantine
		// diagnostics (integrity wins the budget), so on its own it cannot
		// prove the deferral exists. This small scenario keeps the total under
		// the 16-diagnostic cap: the lane-voiding diagnostic must be present,
		// every quarantine diagnostic must also be present (the flush ran),
		// and the lane-voiding diagnostic must precede all of them.
		await establishReviewPrerequisites();
		const unassignedLanes = [
			{
				laneId: 'lane-unassigned',
				workflowLane: 'lane-unassigned',
				reviewItemIds: ['C-0'],
			},
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			unassignedLanes,
			{ batchId: 'small-oldest', prHeadSha: HEAD_SHA },
		);
		await persistBatch(
			'small-oldest',
			'swarm-pr-review:reviewer',
			unassignedLanes,
			{
				textOverride:
					'[REVIEWED] | C-unassigned | CONFIRMED | STATIC_TRACE_PROVEN | HIGH | YES | file.ts:1 | rationale long | probe text | notes | UNKNOWN |',
			},
		);
		const strayLanes = [
			{ laneId: 'lane-q-1', workflowLane: 'lane-q-1', reviewItemIds: ['C-1'] },
			{ laneId: 'lane-q-2', workflowLane: 'lane-q-2', reviewItemIds: ['C-2'] },
		];
		await recordPrReviewValidationBatch(
			tempDir,
			SESSION_ID,
			'reviewer',
			strayLanes,
			{
				batchId: 'small-new',
				prHeadSha: HEAD_SHA,
			},
		);
		for (const lane of strayLanes) {
			const index = Number(lane.laneId.split('-').pop());
			await persistBatch('small-new', 'swarm-pr-review:reviewer', [lane], {
				textOverride: `[REVIEWED] | stray-${index} | APPROVED | looks fine`,
			});
		}
		_test_exports.resetTrackedStateCache();
		const composed = await _test_exports.composePrReviewPhaseVerdicts(
			tempDir,
			SESSION_ID,
			'reviewer',
		);
		const unassignedIndex = composed.diagnostics.findIndex((line: string) =>
			line.includes('contains an unassigned verdict row'),
		);
		expect(unassignedIndex).toBeGreaterThanOrEqual(0);
		const quarantineIndexes = composed.diagnostics
			.map((line: string, index: number) =>
				line.includes('quarantined') ? index : -1,
			)
			.filter((index: number) => index >= 0);
		expect(quarantineIndexes).toHaveLength(2);
		for (const quarantineIndex of quarantineIndexes) {
			expect(quarantineIndex).toBeGreaterThan(unassignedIndex);
		}
	});
});
