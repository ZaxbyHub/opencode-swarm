/**
 * Adaptive drain sizing (issue #1821, Workstream B, AC9).
 *
 * `computeDrainSize` is deliberately pure — no module state, no clock — so the
 * whole adaptive policy is testable in isolation from the queue.
 */

import { describe, expect, it } from 'bun:test';
import {
	_test_exports,
	computeDrainSize,
} from '../../../src/learning/candidate-queue.js';

/** The schema defaults for `learning.realtime_admission`. */
const defaults = {
	minDrain: 1,
	maxDrain: 10,
	drainDepthFactor: 0.5,
	drainVelocityFactor: 0.25,
};

describe('computeDrainSize — degenerate inputs', () => {
	it('drains nothing from an empty queue', () => {
		expect(computeDrainSize(0, 0, defaults)).toBe(0);
	});

	it('drains nothing for a negative or non-finite depth', () => {
		expect(computeDrainSize(-5, 0, defaults)).toBe(0);
		expect(computeDrainSize(Number.NaN, 0, defaults)).toBe(0);
		expect(computeDrainSize(Number.POSITIVE_INFINITY, 0, defaults)).toBe(0);
	});

	it('ignores a negative or non-finite velocity instead of shrinking the batch', () => {
		expect(computeDrainSize(4, -100, defaults)).toBe(
			computeDrainSize(4, 0, defaults),
		);
		expect(computeDrainSize(4, Number.NaN, defaults)).toBe(
			computeDrainSize(4, 0, defaults),
		);
	});
});

describe('computeDrainSize — depth term', () => {
	it('never claims more than the queue actually holds', () => {
		// 1 + 0.5*1 = 1.5 → ceil 2, but depth is 1.
		expect(computeDrainSize(1, 0, defaults)).toBe(1);
		expect(computeDrainSize(2, 0, defaults)).toBe(2);
	});

	it('scales with depth between the min and max bounds', () => {
		// 1 + 0.5*4 = 3
		expect(computeDrainSize(4, 0, defaults)).toBe(3);
		// 1 + 0.5*10 = 6
		expect(computeDrainSize(10, 0, defaults)).toBe(6);
		// 1 + 0.5*17 = 9.5 → ceil 10
		expect(computeDrainSize(17, 0, defaults)).toBe(10);
	});

	it('clamps to maxDrain no matter how deep the backlog is', () => {
		expect(computeDrainSize(500, 0, defaults)).toBe(10);
		expect(computeDrainSize(50_000, 0, defaults)).toBe(10);
	});

	it('honours drainDepthFactor = 0 by drawing only the minimum', () => {
		expect(computeDrainSize(100, 0, { ...defaults, drainDepthFactor: 0 })).toBe(
			1,
		);
	});
});

describe('computeDrainSize — velocity term', () => {
	it('adds a velocity-proportional term on top of the depth term', () => {
		// Depth must exceed the depth-only result for the velocity term to be
		// observable, because the final size is capped by the actual depth.
		// depth-only: 1 + 0.5*10 = 6
		expect(computeDrainSize(10, 0, defaults)).toBe(6);
		// with velocity: 1 + 0.5*10 + 0.25*8 = 8
		expect(computeDrainSize(10, 8, defaults)).toBe(8);
	});

	it('honours drainVelocityFactor = 0 by ignoring arrival rate entirely', () => {
		const noVelocity = { ...defaults, drainVelocityFactor: 0 };
		expect(computeDrainSize(4, 1_000, noVelocity)).toBe(
			computeDrainSize(4, 0, noVelocity),
		);
	});

	it('still clamps to maxDrain under an extreme arrival rate', () => {
		expect(computeDrainSize(20, 10_000, defaults)).toBe(10);
	});
});

describe('computeDrainSize — bound normalization', () => {
	it('raises maxDrain to minDrain when a config inverts them', () => {
		// A max below min must not make the clamp order decide the answer.
		const inverted = { ...defaults, minDrain: 5, maxDrain: 2 };
		expect(computeDrainSize(20, 0, inverted)).toBe(5);
	});

	it('falls back to a minimum of 1 for a zero or negative minDrain', () => {
		expect(computeDrainSize(1, 0, { ...defaults, minDrain: 0 })).toBe(1);
		expect(computeDrainSize(1, 0, { ...defaults, minDrain: -3 })).toBe(1);
	});

	it('never returns more than the depth even with absurd factors', () => {
		// The final depth cap is what makes an over-large factor harmless: a drain
		// can never claim candidates that do not exist.
		const absurd = {
			minDrain: 1,
			maxDrain: 100,
			drainDepthFactor: 50,
			drainVelocityFactor: 50,
		};
		expect(computeDrainSize(3, 1_000, absurd)).toBe(3);
		expect(computeDrainSize(1, 1_000, absurd)).toBe(1);
	});

	it('respects a minDrain larger than the depth by capping at the depth', () => {
		expect(computeDrainSize(2, 0, { ...defaults, minDrain: 8 })).toBe(2);
	});
});

describe('clampUnit — the factor guard (V7)', () => {
	// Tested directly: `computeDrainSize` caps its result by the actual depth, so
	// an un-clamped factor is invisible through the public function. Without this
	// the clamp could be deleted with the whole suite green.
	const { clampUnit } = _test_exports;

	it('passes through a value already in [0, 1]', () => {
		expect(clampUnit(0)).toBe(0);
		expect(clampUnit(0.25)).toBe(0.25);
		expect(clampUnit(1)).toBe(1);
	});

	it('clamps a finite value above 1 down to 1', () => {
		expect(clampUnit(1.5)).toBe(1);
		expect(clampUnit(50)).toBe(1);
	});

	it('floors negatives, NaN, non-finite, and non-numerics at 0', () => {
		// Non-finite floors to 0 ("ignore this factor") rather than clamping to 1
		// ("weight it maximally"): an unparseable weight should not amplify the
		// drain. Unreachable via the schema (`z.number().min(0).max(1)`), so this
		// only guards a hand-written or programmatically-built config.
		expect(clampUnit(-1)).toBe(0);
		expect(clampUnit(Number.NaN)).toBe(0);
		expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clampUnit(undefined)).toBe(0);
		expect(clampUnit('abc')).toBe(0);
	});
});
