import { describe, expect, test } from 'bun:test';
import { _test_exports } from '../../../src/hooks/pr-workflow-gate.js';

const MAX_ASSIGNED_ITEMS = 10_000;

function reviewedRow(itemId: string): string {
	return `[REVIEWED] | ${itemId} | CONFIRMED | STRUCTURALLY_PROVEN | HIGH | YES | file.ts:1 | rationale ${itemId} | probe ${itemId} | reviewer`;
}

function criticRow(itemId: string): string {
	return `[CRITIC] | ${itemId} | UPHELD | HIGH | reason ${itemId} | required change ${itemId}`;
}

describe('PR-review verdict assignment scale boundary', () => {
	test('validates and composes 10,000 reviewer rows within a bounded turn', () => {
		const itemIds = Array.from(
			{ length: MAX_ASSIGNED_ITEMS },
			(_, index) => `C-${index}`,
		);
		const artifact = itemIds.map(reviewedRow).join('\n');

		// Collection calls this exact-contract analyzer before publishing a
		// terminal receipt. It must parse the artifact once, not once per ID.
		const collection = _test_exports.analyzePrReviewVerdictRowContract(
			artifact,
			itemIds,
			'reviewer',
		);
		expect(collection.ok).toBe(true);

		// Settlement calls this item composer over the same artifact. Exercising
		// both production parsers in one timeout catches a quadratic regression.
		const settled = _test_exports.parseLaneItemVerdicts(
			artifact,
			itemIds,
			'reviewer',
		);
		expect(settled.size).toBe(MAX_ASSIGNED_ITEMS);
		expect(settled.get('C-0')).toMatchObject({
			classification: 'CONFIRMED',
			severity: 'HIGH',
		});
		expect(settled.has('C-9999')).toBe(true);
	}, 5_000);

	test('validates and composes 10,000 critic rows within a bounded turn', () => {
		const itemIds = Array.from(
			{ length: MAX_ASSIGNED_ITEMS },
			(_, index) => `C-${index}`,
		);
		const artifact = itemIds.map(criticRow).join('\n');
		const reviewerClaims = new Map(
			itemIds.map((itemId) => [
				itemId,
				{
					batchId: 'reviewer-batch',
					laneId: 'reviewer-lane',
					workflowLane: 'reviewer-lane',
					classification: 'CONFIRMED',
					severity: 'HIGH',
				},
			]),
		);

		const collection = _test_exports.analyzePrReviewVerdictRowContract(
			artifact,
			itemIds,
			'critic',
			reviewerClaims,
		);
		expect(collection.ok).toBe(true);
		const settled = _test_exports.parseLaneItemVerdicts(
			artifact,
			itemIds,
			'critic',
			reviewerClaims,
		);
		expect(settled.size).toBe(MAX_ASSIGNED_ITEMS);
		expect(settled.get('C-9999')).toEqual({
			classification: 'UPHELD',
			severity: 'HIGH',
		});
	}, 5_000);
});
