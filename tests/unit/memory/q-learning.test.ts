import { describe, expect, test } from 'bun:test';
import {
	applyEmaUpdate,
	applyPropagatedEmaUpdate,
	getQValue,
	setQValue,
} from '../../../src/memory/q-learning';

describe('applyEmaUpdate — EMA math (q ← (1-η)·q + η·reward)', () => {
	test('exact combination: applyEmaUpdate(0.5, 1, 0.1) === 0.55', () => {
		// (1-0.1)*0.5 + 0.1*1 = 0.45 + 0.1 = 0.55
		expect(applyEmaUpdate(0.5, 1, 0.1)).toBeCloseTo(0.55, 10);
	});

	test('SC-003: repeated APPROVE (reward=1.0) converges upward and never decreases', () => {
		let q = 0.5;
		let previous = q;
		for (let i = 0; i < 50; i++) {
			q = applyEmaUpdate(q, 1.0, 0.1);
			// A no-op / broken EMA (e.g. one that ignores reward or averages toward 0)
			// would fail this monotonicity check immediately.
			expect(q).toBeGreaterThanOrEqual(previous);
			previous = q;
		}
		expect(q).toBeGreaterThan(0.99);
	});

	test('SC-004: alternating 1.0/0.0 rewards stabilize near neutral, never suppressed toward 0', () => {
		let q = 0.5;
		for (let i = 0; i < 200; i++) {
			const reward = i % 2 === 0 ? 1.0 : 0.0;
			q = applyEmaUpdate(q, reward, 0.1);
			// Coherence-fix guarantee: a balanced (alternating) memory must not decay
			// toward the suppression floor. A broken implementation that biases
			// toward 0 (e.g. treats missing/0 reward as full suppression rather
			// than convex combination) would push q below this band.
			expect(q).toBeGreaterThan(0.15);
		}
		// Ends within ~0.1 of the neutral point.
		expect(Math.abs(q - 0.5)).toBeLessThan(0.1);
	});

	test('SC-015: CONCERNS (reward=0.5) regresses a high q-value downward toward neutral', () => {
		const result = applyEmaUpdate(0.9, 0.5, 0.1);
		expect(result).toBeLessThan(0.9);
		expect(result).toBeGreaterThan(0.5);
	});

	test('SC-015: CONCERNS (reward=0.5) regresses a low q-value upward toward neutral', () => {
		const result = applyEmaUpdate(0.2, 0.5, 0.1);
		expect(result).toBeGreaterThan(0.2);
		expect(result).toBeLessThan(0.5);
	});

	test('clamps an out-of-range reward (1.5) to at most 1', () => {
		const result = applyEmaUpdate(0.9, 1.5, 0.5);
		// (1-0.5)*0.9 + 0.5*1.5 = 0.45 + 0.75 = 1.2, must clamp to 1
		expect(result).toBeLessThanOrEqual(1);
		expect(result).toBe(1);
	});

	test('clamps an out-of-range negative reward to at least 0', () => {
		const result = applyEmaUpdate(0.1, -5, 0.5);
		// (1-0.5)*0.1 + 0.5*(-5) = 0.05 - 2.5 = -2.45, must clamp to 0
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBe(0);
	});

	test('non-finite qOld falls back to 0 (documented current behavior)', () => {
		// Source: `if (!Number.isFinite(qOld)) return 0;`
		// This is asserted as documentation of actual behavior, not endorsement —
		// a NaN/Infinity qOld silently resets the learned value to 0 rather than
		// falling back to a neutral 0.5. Flagging this in case it's unintended,
		// but the test locks in the CURRENT contract so a future change is deliberate.
		expect(applyEmaUpdate(Number.NaN, 1, 0.1)).toBe(0);
		expect(applyEmaUpdate(Number.POSITIVE_INFINITY, 1, 0.1)).toBe(0);
		expect(applyEmaUpdate(Number.NEGATIVE_INFINITY, 1, 0.1)).toBe(0);
	});

	test('non-finite reward or eta falls back to the clamped qOld unchanged', () => {
		expect(applyEmaUpdate(0.7, Number.NaN, 0.1)).toBe(0.7);
		expect(applyEmaUpdate(0.7, 1, Number.NaN)).toBe(0.7);
		expect(applyEmaUpdate(0.7, Number.POSITIVE_INFINITY, 0.1)).toBe(0.7);
		expect(applyEmaUpdate(0.7, 1, Number.POSITIVE_INFINITY)).toBe(0.7);
	});

	test('qOld out of [0,1] range (but finite) is combined then clamped, not rejected', () => {
		// qOld=1.5, reward=0, eta=0.1 => (0.9*1.5)+(0.1*0) = 1.35 -> clamp to 1
		expect(applyEmaUpdate(1.5, 0, 0.1)).toBe(1);
		// qOld=-0.5, reward=1, eta=0.1 => (0.9*-0.5)+(0.1*1) = -0.45+0.1 = -0.35 -> clamp to 0
		expect(applyEmaUpdate(-0.5, 1, 0.1)).toBe(0);
	});

	test('eta=0 leaves qOld unchanged (no learning)', () => {
		expect(applyEmaUpdate(0.42, 1, 0)).toBeCloseTo(0.42, 10);
	});

	test('eta=1 fully replaces qOld with the (clamped) reward', () => {
		expect(applyEmaUpdate(0.42, 0.9, 1)).toBeCloseTo(0.9, 10);
	});
});

describe('applyPropagatedEmaUpdate — B.5 fractionally-reduced propagation step', () => {
	test('shifts by EXACTLY `fraction` times the direct shift from the same qOld', () => {
		const qOld = 0.5;
		const reward = 1;
		const eta = 0.1;
		const fraction = 0.3;
		const directShift = applyEmaUpdate(qOld, reward, eta) - qOld; // +0.05
		const propagated = applyPropagatedEmaUpdate(qOld, reward, eta, fraction);
		// applyEmaUpdate(0.5, 1, 0.1*0.3=0.03) = 0.97*0.5 + 0.03 = 0.515
		expect(propagated).toBeCloseTo(0.515, 10);
		expect(propagated - qOld).toBeCloseTo(fraction * directShift, 10);
	});

	test('equals a plain EMA step whose learning rate is scaled by the fraction', () => {
		expect(applyPropagatedEmaUpdate(0.42, 0.9, 0.2, 0.5)).toBeCloseTo(
			applyEmaUpdate(0.42, 0.9, 0.2 * 0.5),
			10,
		);
	});

	test('fraction <= 0 or non-finite yields NO shift (clamped qOld)', () => {
		expect(applyPropagatedEmaUpdate(0.6, 1, 0.1, 0)).toBeCloseTo(0.6, 10);
		expect(applyPropagatedEmaUpdate(0.6, 1, 0.1, -0.5)).toBeCloseTo(0.6, 10);
		expect(applyPropagatedEmaUpdate(0.6, 1, 0.1, Number.NaN)).toBeCloseTo(
			0.6,
			10,
		);
	});

	test('fraction > 1 is capped at 1 so a propagated step never exceeds the direct step', () => {
		// fraction 5 must behave like fraction 1 (a full direct step), never larger.
		expect(applyPropagatedEmaUpdate(0.5, 1, 0.1, 5)).toBeCloseTo(
			applyEmaUpdate(0.5, 1, 0.1),
			10,
		);
	});
});

describe('getQValue — reads metadata.qValue with fallback semantics', () => {
	test('returns the stored finite in-range qValue', () => {
		expect(getQValue({ metadata: { qValue: 0.73 } })).toBe(0.73);
	});

	test('returns default fallback (0.5) when metadata is absent', () => {
		expect(getQValue({})).toBe(0.5);
	});

	test('returns default fallback (0.5) when qValue key is absent', () => {
		expect(getQValue({ metadata: { other: 'x' } })).toBe(0.5);
	});

	test('returns default fallback when qValue is not a number', () => {
		expect(
			getQValue({ metadata: { qValue: '0.9' as unknown as number } }),
		).toBe(0.5);
		expect(getQValue({ metadata: { qValue: null as unknown as number } })).toBe(
			0.5,
		);
	});

	test('returns default fallback when qValue is NaN', () => {
		expect(getQValue({ metadata: { qValue: Number.NaN } })).toBe(0.5);
	});

	test('returns default fallback when qValue is out of [0,1] range', () => {
		expect(getQValue({ metadata: { qValue: 1.5 } })).toBe(0.5);
		expect(getQValue({ metadata: { qValue: -0.1 } })).toBe(0.5);
	});

	test('respects a custom fallback argument', () => {
		expect(getQValue({}, 0.2)).toBe(0.2);
		expect(getQValue({ metadata: { qValue: Number.NaN } }, 0.9)).toBe(0.9);
	});

	test('boundary values 0 and 1 are accepted as valid stored qValues', () => {
		expect(getQValue({ metadata: { qValue: 0 } })).toBe(0);
		expect(getQValue({ metadata: { qValue: 1 } })).toBe(1);
	});
});

describe('setQValue — immutable metadata update', () => {
	test('returns a NEW object; does not mutate the original record', () => {
		const original = { metadata: { qValue: 0.5, other: 'keep-me' } };
		const updated = setQValue(original, 0.8);

		expect(updated).not.toBe(original);
		expect(updated.metadata).not.toBe(original.metadata);
		// Original must be untouched.
		expect(original.metadata.qValue).toBe(0.5);
		expect(updated.metadata.qValue).toBe(0.8);
	});

	test('preserves other metadata keys', () => {
		const original = {
			metadata: { qValue: 0.1, sourceTool: 'reviewer', count: 3 },
		};
		const updated = setQValue(original, 0.6);

		expect(updated.metadata.sourceTool).toBe('reviewer');
		expect(updated.metadata.count).toBe(3);
		expect(updated.metadata.qValue).toBe(0.6);
	});

	test('clamps an out-of-range value into [0,1]', () => {
		expect(setQValue({ metadata: {} }, 1.7).metadata?.qValue).toBe(1);
		expect(setQValue({ metadata: {} }, -3).metadata?.qValue).toBe(0);
	});

	test('non-finite value falls back to 0 before clamping', () => {
		expect(setQValue({ metadata: {} }, Number.NaN).metadata?.qValue).toBe(0);
		expect(
			setQValue({ metadata: {} }, Number.POSITIVE_INFINITY).metadata?.qValue,
		).toBe(0);
	});

	test('works when the original record has no metadata at all', () => {
		const updated = setQValue({}, 0.4);
		expect(updated.metadata?.qValue).toBe(0.4);
	});

	test('other top-level fields of the record are preserved (spread)', () => {
		const original = { id: 'mem_1', metadata: { qValue: 0.3 } };
		const updated = setQValue(original, 0.9);
		expect(updated.id).toBe('mem_1');
		expect(updated.metadata?.qValue).toBe(0.9);
	});
});
