import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	PR_REVIEW_BASE_LANE_FLOORS,
	PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	attemptBaseBatch,
	failEntireInitialWave,
	recordInitialWave,
	setupTierLFixtures,
	TIER_L_MESSAGE,
	teardownTierLFixtures,
} from './dispatch-lanes-pr-review-tier-l.test-fixtures.js';

/**
 * Issue #1968 review round 2, MUST-FIX A — the cumulative tier-L floor must be
 * measured as a MINIMUM COVER of the consolidated dimensions, not as a count of
 * declared consolidated lane instances.
 *
 * Declaring a lane is free, so a count of declarations inflates without bound
 * while `consolidatedDimensions` saturates at six. Two families of declaration
 * defeat a count-of-declarations floor while satisfying every other clause:
 *
 * 1. **Overlapping pairs.** Four pairwise consolidations, each individually
 *    legal, whose union is all six dimensions — but three of which already cover
 *    all six. The wave then settles at three producing lanes of two dimensions
 *    each: exactly `PR_REVIEW_BASE_LANE_FLOORS.M`, i.e. the tier-L depth the
 *    floor exists to defend has been silently downgraded to a tier-M dispatch.
 * 2. **Duplicate declarations.** The same consolidated set re-declared across
 *    several batches, each re-declaration buying a lane of budget it does not
 *    back, settling at two producing lanes.
 *
 * The floor constant is not the defect and must not be raised: any cover of six
 * dimensions containing at least one multi-element set has at most five sets, so
 * a floor of six would forbid all consolidation and delete the retry exception.
 */

const [DIM_A, DIM_B, DIM_C, DIM_D, DIM_E, DIM_F] = PR_REVIEW_BASE_DIMENSION_IDS;

beforeEach(setupTierLFixtures);
afterEach(teardownTierLFixtures);

/** One consolidated lane owning `owned`, declared as its own base batch. */
function consolidatedBatch(
	owned: readonly string[],
	batchId: string,
): Promise<Error | null> {
	return attemptBaseBatch(
		[
			{
				laneId: `${batchId}-lane`,
				workflowLane: owned[0] as string,
				ownedWorkflowLanes: [...owned],
			},
		],
		batchId,
	);
}

describe('PR_REVIEW tier-L cumulative floor counts a minimum cover', () => {
	test('overlapping pair consolidations cannot settle at the tier-M lane count', async () => {
		await recordInitialWave();
		await failEntireInitialWave();

		// Three pairs are accepted: each leaves a cover strictly larger than the
		// floor once the dimensions no consolidated lane claims are added back.
		expect(await consolidatedBatch([DIM_A, DIM_B], 'pair-ab')).toBeNull();
		expect(await consolidatedBatch([DIM_B, DIM_C], 'pair-bc')).toBeNull();
		expect(await consolidatedBatch([DIM_D, DIM_E], 'pair-de')).toBeNull();

		// The fourth pair completes a three-set cover of all six dimensions
		// ({B,C}, {D,E}, {F,A}), so the wave would be backed by three lanes — the
		// tier-M dispatch shape. Counting declarations instead of a cover admitted
		// this, because four separate lane objects had been declared.
		const error = await consolidatedBatch([DIM_F, DIM_A], 'pair-fa');
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			`this wave would be backed by only ${PR_REVIEW_BASE_LANE_FLOORS.M} distinct lanes`,
		);
		expect(error?.message).toContain(
			`at least ${PR_REVIEW_TIER_L_CONSOLIDATED_LANE_FLOOR} distinct`,
		);
	});

	test('re-declaring the same consolidated set buys no additional budget', async () => {
		await recordInitialWave();
		await failEntireInitialWave();

		// The identical three-dimension set, declared three times. Each declaration
		// used to add one to the backing count while covering nothing new.
		for (const attempt of ['dup-1', 'dup-2', 'dup-3']) {
			expect(
				await consolidatedBatch([DIM_A, DIM_B, DIM_C], attempt),
			).toBeNull();
		}

		// Two sets now cover all six dimensions, so the wave would be backed by two
		// producing lanes — below even the tier-M shape.
		const error = await consolidatedBatch([DIM_D, DIM_E, DIM_F], 'dup-def');
		expect(error?.message).toContain(TIER_L_MESSAGE);
		expect(error?.message).toContain(
			'this wave would be backed by only 2 distinct lanes',
		);
	});
});

const { minimumConsolidatedLaneCover, MAX_COVER_UNIVERSE_BITS } = gateInternals;

/** `count` synthetic dimension ids, distinct from the six real ones. */
function synthetic(count: number): string[] {
	return Array.from({ length: count }, (_value, index) => `d${index}`);
}

describe('minimumConsolidatedLaneCover', () => {
	test('no consolidated lane costs nothing', () => {
		expect(minimumConsolidatedLaneCover([])).toBe(0);
	});

	test('identical sets collapse to a single covering lane', () => {
		expect(
			minimumConsolidatedLaneCover([
				[DIM_A, DIM_B, DIM_C],
				[DIM_C, DIM_B, DIM_A],
				[DIM_A, DIM_B, DIM_C],
			]),
		).toBe(1);
	});

	test('disjoint sets each cost a lane', () => {
		expect(
			minimumConsolidatedLaneCover([
				[DIM_A, DIM_B],
				[DIM_C, DIM_D],
				[DIM_E, DIM_F],
			]),
		).toBe(3);
	});

	test('the cover is exact and order-independent for overlapping sets', () => {
		// {B,C} + {D,E} + {F,A} covers all six, so {A,B} is redundant. A greedy
		// subset-elimination walk answers 4 in this order and 3 in the reverse; an
		// order-dependent count is not a floor, because declaration order belongs
		// to the controller being gated.
		const sets = [
			[DIM_A, DIM_B],
			[DIM_B, DIM_C],
			[DIM_D, DIM_E],
			[DIM_F, DIM_A],
		];
		expect(minimumConsolidatedLaneCover(sets)).toBe(3);
		expect(minimumConsolidatedLaneCover([...sets].reverse())).toBe(3);
	});

	test('an oversized universe falls back to a fail-closed lower bound', () => {
		// One wide set plus three pairs. The exact cover is 4; the bound is
		// ceil(|universe| / largest set). Sized to straddle MAX_COVER_UNIVERSE_BITS
		// so the two branches are driven by the same shape.
		const wide = MAX_COVER_UNIVERSE_BITS - 6;
		const build = (extra: number): string[][] => {
			const ids = synthetic(wide + extra + 6);
			return [
				ids.slice(0, wide + extra),
				ids.slice(wide + extra, wide + extra + 2),
				ids.slice(wide + extra + 2, wide + extra + 4),
				ids.slice(wide + extra + 4, wide + extra + 6),
			];
		};
		// Exactly at the bound: the exact DP runs.
		expect(minimumConsolidatedLaneCover(build(0))).toBe(4);
		// One dimension past it: the lower bound runs instead, and it is a genuine
		// lower bound — never above the exact answer, so it can only reject more.
		const oversized = build(1);
		const bound = Math.ceil(
			(MAX_COVER_UNIVERSE_BITS + 1) / (MAX_COVER_UNIVERSE_BITS - 5),
		);
		expect(minimumConsolidatedLaneCover(oversized)).toBe(bound);
		expect(bound).toBeLessThanOrEqual(4);
	});
});
