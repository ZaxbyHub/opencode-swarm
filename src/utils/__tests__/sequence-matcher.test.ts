import { describe, expect, test } from 'bun:test';
import { SequenceMatcher } from '../sequence-matcher';

/** Assert two floats are equal within a small epsilon (diffeq-style). */
function expectRatio(actual: number, expected: number): void {
	expect(Math.abs(actual - expected)).toBeLessThan(1e-9);
}

/**
 * Faithful-port acceptance tests for the TypeScript SequenceMatcher.
 *
 * Every ratio/opcodes/matching-blocks value below was computed against
 * CPython 3.x `difflib.SequenceMatcher` so the fuzzy-match thresholds
 * (0.50 / 0.70 / 0.80) behave identically to the Python original.
 */
describe('SequenceMatcher.ratio', () => {
	test("'abcd' vs 'bcde' is 0.75", () => {
		expectRatio(new SequenceMatcher(null, 'abcd', 'bcde').ratio(), 0.75);
	});

	test('identical strings ratio 1.0', () => {
		expectRatio(new SequenceMatcher(null, 'hello', 'hello').ratio(), 1.0);
	});

	test('both empty ratio 1.0', () => {
		expectRatio(new SequenceMatcher(null, '', '').ratio(), 1.0);
	});

	test('single identical char ratio 1.0', () => {
		expectRatio(new SequenceMatcher(null, 'a', 'a').ratio(), 1.0);
	});

	test('disjoint single chars ratio 0.0', () => {
		expectRatio(new SequenceMatcher(null, 'a', 'b').ratio(), 0.0);
	});

	test('disjoint strings ratio 0.0', () => {
		expectRatio(new SequenceMatcher(null, 'abc', 'xyz').ratio(), 0.0);
	});

	test("'qabxcd' vs 'abycdf' ratio 2/3", () => {
		// CPython: SequenceMatcher(None, 'qabxcd', 'abycdf').ratio() = 0.6666...
		expectRatio(
			new SequenceMatcher(null, 'qabxcd', 'abycdf').ratio(),
			0.6666666666666666,
		);
	});

	test('block_anchor high-sim middle ratio 0.9474', () => {
		// Used by strategy 8 threshold (>=0.50 for unique). Real CPython value.
		const r = new SequenceMatcher(
			null,
			'    x = 1\n    y = 2',
			'    x = 1\n    y = 9',
		).ratio();
		expectRatio(r, 0.9473684210526315);
	});

	test('block_anchor low-sim middle ratio 0.4423', () => {
		// Below 0.50 → block_anchor must NOT match. Real CPython value.
		const cm =
			"    completely = 'unrelated'\n    content = 'here'\n    nothing = 'in common'";
		const pm = '    x = 1\n    y = 2\n    z = 3';
		expectRatio(new SequenceMatcher(null, cm, pm).ratio(), 0.4423076923076923);
	});
});

describe('SequenceMatcher.getMatchingBlocks', () => {
	test('returns matching blocks plus zero-size sentinel', () => {
		const mb = new SequenceMatcher(
			null,
			'qabxcd',
			'abycdf',
		).getMatchingBlocks();
		expect(mb).toEqual([
			{ a: 1, b: 0, size: 2 },
			{ a: 4, b: 3, size: 2 },
			{ a: 6, b: 6, size: 0 },
		]);
	});

	test('identical strings produce a single full match + sentinel', () => {
		const mb = new SequenceMatcher(null, 'abc', 'abc').getMatchingBlocks();
		expect(mb).toEqual([
			{ a: 0, b: 0, size: 3 },
			{ a: 3, b: 3, size: 0 },
		]);
	});

	test('disjoint strings produce only the sentinel', () => {
		const mb = new SequenceMatcher(null, 'abc', 'xyz').getMatchingBlocks();
		expect(mb).toEqual([{ a: 3, b: 3, size: 0 }]);
	});
});

describe('SequenceMatcher.getOpcodes', () => {
	test("'qabxcd' → 'abycdf' opcodes match CPython doc example", () => {
		const ops = new SequenceMatcher(null, 'qabxcd', 'abycdf').getOpcodes();
		expect(ops).toEqual([
			{ tag: 'delete', i1: 0, i2: 1, j1: 0, j2: 0 },
			{ tag: 'equal', i1: 1, i2: 3, j1: 0, j2: 2 },
			{ tag: 'replace', i1: 3, i2: 4, j1: 2, j2: 3 },
			{ tag: 'equal', i1: 4, i2: 6, j1: 3, j2: 5 },
			{ tag: 'insert', i1: 6, i2: 6, j1: 5, j2: 6 },
		]);
	});

	test('identical strings produce a single equal opcode', () => {
		const ops = new SequenceMatcher(null, 'abc', 'abc').getOpcodes();
		expect(ops).toEqual([{ tag: 'equal', i1: 0, i2: 3, j1: 0, j2: 3 }]);
	});

	test('pure insertion produces an insert opcode', () => {
		const ops = new SequenceMatcher(null, 'ab', 'axb').getOpcodes();
		expect(ops).toEqual([
			{ tag: 'equal', i1: 0, i2: 1, j1: 0, j2: 1 },
			{ tag: 'insert', i1: 1, i2: 1, j1: 1, j2: 2 },
			{ tag: 'equal', i1: 1, i2: 2, j1: 2, j2: 3 },
		]);
	});
});

describe('SequenceMatcher autojunk (popular-element guard)', () => {
	test('autojunk=True excludes popular elements from anchoring', () => {
		// b has 300 chars: 'x' ~16.7%, 'y' ~83.3% — both >1% are popular.
		// CPython with autojunk=True: ratio 0.006622516556291391.
		const b = 'x'.repeat(50) + 'y'.repeat(250);
		expectRatio(
			new SequenceMatcher(null, 'xy', b, true).ratio(),
			0.006622516556291391,
		);
	});

	test('autojunk=False allows popular elements to anchor', () => {
		// Same input, autojunk off → longer matching blocks → higher ratio.
		// CPython with autojunk=False: 0.013245033112582781.
		const b = 'x'.repeat(50) + 'y'.repeat(250);
		expectRatio(
			new SequenceMatcher(null, 'xy', b, false).ratio(),
			0.013245033112582781,
		);
	});

	test('autojunk does not fire on short sequences (< 200 chars)', () => {
		// b is short — popular guard is inert, autojunk on/off give the same ratio.
		const b = 'a'.repeat(50) + 'b'.repeat(50); // 100 chars
		const on = new SequenceMatcher(null, 'ab', b, true).ratio();
		const off = new SequenceMatcher(null, 'ab', b, false).ratio();
		expectRatio(on, off);
	});
});

describe('SequenceMatcher edge cases', () => {
	test('empty `a` against non-empty `b` ratio 0.0', () => {
		expectRatio(new SequenceMatcher(null, '', 'abc').ratio(), 0.0);
	});

	test('non-empty `a` against empty `b` ratio 0.0', () => {
		expectRatio(new SequenceMatcher(null, 'abc', '').ratio(), 0.0);
	});

	test('astral-plane (emoji) input does not crash or corrupt', () => {
		// Round-trip safety: UTF-16 code-unit indexing must be internally
		// consistent. An emoji consumes 2 units; the matcher must not throw
		// or produce NaN.
		const a = '😀 hello';
		const b = '😀 world';
		const r = new SequenceMatcher(null, a, b).ratio();
		expect(Number.isFinite(r)).toBe(true);
		expect(r).toBeGreaterThan(0.0);
		expect(r).toBeLessThanOrEqual(1.0);
		const ops = new SequenceMatcher(null, a, b).getOpcodes();
		// Must cover the full sequences.
		const last = ops[ops.length - 1];
		expect(last.i2).toBe(a.length);
		expect(last.j2).toBe(b.length);
	});

	test('setSeqs resets cached matching blocks', () => {
		const sm = new SequenceMatcher(null, 'abc', 'xyz');
		const r1 = sm.ratio();
		expect(r1).toBe(0.0);
		sm.setSeqs('abc', 'abc');
		expect(sm.ratio()).toBe(1.0);
	});
});
