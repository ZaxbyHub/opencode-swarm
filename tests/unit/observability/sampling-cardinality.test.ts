/**
 * `shouldSample` determinism and `assertBoundedCardinality` allowlist
 * enforcement (issue #2029).
 */
import { describe, expect, test } from 'bun:test';
import {
	assertBoundedCardinality,
	METRIC_LABEL_ALLOWLIST,
	shouldSample,
} from '../../../src/observability/sampling.js';

const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('shouldSample', () => {
	test('is deterministic for a given traceId+rate — repeated calls agree', () => {
		const results = new Set<boolean>();
		for (let i = 0; i < 20; i++) {
			results.add(shouldSample(TRACE_ID, 0.5));
		}
		expect(results.size).toBe(1);
	});

	test('is stable across many different traceIds at a fixed mid rate (no crash, deterministic per id)', () => {
		for (let i = 0; i < 50; i++) {
			const id = i.toString(16).padStart(32, '0');
			const first = shouldSample(id, 0.5);
			const second = shouldSample(id, 0.5);
			expect(first).toBe(second);
		}
	});

	test('rate >= 1 is always true, regardless of traceId', () => {
		expect(shouldSample(TRACE_ID, 1)).toBe(true);
		expect(shouldSample(TRACE_ID, 2)).toBe(true);
		expect(shouldSample('0'.repeat(32), 1)).toBe(true);
		expect(shouldSample('garbage-not-hex', 1)).toBe(true);
	});

	test('rate <= 0 is always false, regardless of traceId', () => {
		expect(shouldSample(TRACE_ID, 0)).toBe(false);
		expect(shouldSample(TRACE_ID, -1)).toBe(false);
		expect(shouldSample('f'.repeat(32), 0)).toBe(false);
	});

	test('malformed traceId (too short) fails OPEN (true) at a mid rate', () => {
		expect(shouldSample('short', 0.5)).toBe(true);
	});

	test('malformed traceId (non-hex suffix) fails OPEN (true) at a mid rate', () => {
		const nonHex = `${'a'.repeat(24)}zzzzzzzz`;
		expect(shouldSample(nonHex, 0.5)).toBe(true);
	});

	test('malformed traceId (empty string) fails OPEN (true)', () => {
		expect(shouldSample('', 0.5)).toBe(true);
	});

	test('non-finite rate (NaN) fails OPEN (true), not silently drops everything', () => {
		expect(shouldSample(TRACE_ID, Number.NaN)).toBe(true);
	});

	test('non-finite rate (Infinity) fails OPEN (true)', () => {
		expect(shouldSample(TRACE_ID, Number.POSITIVE_INFINITY)).toBe(true);
	});

	test('non-finite rate (-Infinity) fails OPEN (true) — not routed through the <=0 branch as false', () => {
		// -Infinity <= 0 is mathematically true, but the function's own explicit
		// non-finite guard runs FIRST and must win, per the fail-open contract.
		expect(shouldSample(TRACE_ID, Number.NEGATIVE_INFINITY)).toBe(true);
	});

	test('a max-value suffix (0xffffffff) is NOT sampled at a rate just under 1 (value/denominator == 1.0, not < rate)', () => {
		const maxSuffix = `${'0'.repeat(24)}ffffffff`;
		// value = 0xffffffff = SAMPLE_DENOMINATOR exactly, so value/denominator ==
		// 1.0, which is never `< rate` for any rate < 1 — this trace id is the
		// deterministic "last" one dropped as the rate approaches 1 from below.
		expect(shouldSample(maxSuffix, 0.999999999)).toBe(false);
		// ...but IS sampled once the rate reaches exactly 1 (the rate>=1 fast path).
		expect(shouldSample(maxSuffix, 1)).toBe(true);
	});

	test('a zero-suffix trace id at a tiny positive rate samples true (near-min value)', () => {
		const allZeroSuffix = `${'a'.repeat(24)}00000000`;
		expect(shouldSample(allZeroSuffix, 0.0001)).toBe(true);
	});
});

describe('assertBoundedCardinality', () => {
	test('accepts every allowlisted label', () => {
		for (const label of METRIC_LABEL_ALLOWLIST) {
			const verdict = assertBoundedCardinality([label]);
			expect(verdict.ok).toBe(true);
		}
	});

	test('accepts the full allowlist as one call', () => {
		const verdict = assertBoundedCardinality([...METRIC_LABEL_ALLOWLIST]);
		expect(verdict.ok).toBe(true);
	});

	test('rejects taskId', () => {
		const verdict = assertBoundedCardinality(['taskId']);
		expect(verdict.ok).toBe(false);
	});

	test('rejects sessionId', () => {
		const verdict = assertBoundedCardinality(['sessionId']);
		expect(verdict.ok).toBe(false);
	});

	test('rejects filePath', () => {
		const verdict = assertBoundedCardinality(['filePath']);
		expect(verdict.ok).toBe(false);
	});

	test('rejects repo', () => {
		const verdict = assertBoundedCardinality(['repo']);
		expect(verdict.ok).toBe(false);
	});

	test('rejects user', () => {
		const verdict = assertBoundedCardinality(['user']);
		expect(verdict.ok).toBe(false);
	});

	test('rejects a/b (slash-shaped label)', () => {
		const verdict = assertBoundedCardinality(['a/b']);
		expect(verdict.ok).toBe(false);
	});

	test('never throws — hostile array-like input', () => {
		const hostile = new Proxy([], {
			get(target, prop) {
				if (prop === Symbol.iterator) {
					throw new Error('boom');
				}
				return Reflect.get(target, prop);
			},
		});
		expect(() =>
			assertBoundedCardinality(hostile as unknown as string[]),
		).not.toThrow();
	});

	test('never throws — array containing non-string values', () => {
		const weird = [42, null, undefined, {}, Symbol('x')] as unknown as string[];
		expect(() => assertBoundedCardinality(weird)).not.toThrow();
		const verdict = assertBoundedCardinality(weird);
		expect(verdict.ok).toBe(false);
	});

	test('never throws — empty array is valid (vacuously ok)', () => {
		expect(() => assertBoundedCardinality([])).not.toThrow();
		expect(assertBoundedCardinality([]).ok).toBe(true);
	});
});
