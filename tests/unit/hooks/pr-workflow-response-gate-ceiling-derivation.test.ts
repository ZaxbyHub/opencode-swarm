import { describe, expect, test } from 'bun:test';
import {
	PR_REVIEW_BASE_LANE_FLOORS,
	PR_REVIEW_MICRO_LANE_FLOORS,
	type PrReviewDepthTier,
} from '../../../src/hooks/pr-workflow-gate.js';
import { DEFAULT_TOTAL_WAKE_CEILINGS } from '../../../src/hooks/pr-workflow-response-gate.js';

/**
 * Regression: F-010. `DEFAULT_TOTAL_WAKE_CEILINGS` is documented as derived
 * proportionally from each tier's lane-floor workload (base + micro lanes)
 * times a fixed headroom multiplier of 6. That derivation is currently
 * expressed only in a source comment, not in code — so a future change to
 * `PR_REVIEW_BASE_LANE_FLOORS` or `PR_REVIEW_MICRO_LANE_FLOORS` (e.g. adding a
 * new required base dimension or risk family) could silently leave the
 * ceilings mis-sized relative to the workload they are supposed to bound,
 * with nothing failing to flag the drift. This test pins the derivation as an
 * executable invariant instead of prose.
 */
describe('DEFAULT_TOTAL_WAKE_CEILINGS — regression: ceilings stay derived from the lane floors (F-010)', () => {
	test('every tier ceiling equals (base lane floor + micro lane floor) * 6', () => {
		const HEADROOM_MULTIPLIER = 6;
		const tiers: PrReviewDepthTier[] = ['S', 'M', 'L'];
		for (const tier of tiers) {
			const expected =
				(PR_REVIEW_BASE_LANE_FLOORS[tier] + PR_REVIEW_MICRO_LANE_FLOORS[tier]) *
				HEADROOM_MULTIPLIER;
			expect(DEFAULT_TOTAL_WAKE_CEILINGS[tier]).toBe(expected);
		}
	});
});
