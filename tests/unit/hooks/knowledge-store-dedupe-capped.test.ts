/**
 * Unit tests for `dedupeCapped` (issue #1821 Lane 0b).
 *
 * `dedupeCapped` replaces the bare positional `.slice(0, 20)` that recurred at
 * six knowledge call sites. The defect: the cap was positional and nothing
 * deduplicated first, so duplicate values both SURVIVED and — because the cap
 * counts positions, not distinct values — EVICTED distinct values off the end.
 *
 * The pipeline order is observable and is pinned here:
 *   non-array -> [] | drop non-strings | truncate | dedupe (case-insensitive,
 *   first casing wins) | cap (keep first N)
 *
 * Tier-0 pure-function tests: no mocks, no filesystem, no DI seam needed.
 */

import { describe, expect, it } from 'bun:test';
import { dedupeCapped } from '../../../src/hooks/knowledge-store';

describe('dedupeCapped — step 1: non-array input', () => {
	it('returns an empty array for every non-array input', () => {
		expect(dedupeCapped(undefined, { cap: 20 })).toEqual([]);
		expect(dedupeCapped(null, { cap: 20 })).toEqual([]);
		expect(dedupeCapped('a,b,c', { cap: 20 })).toEqual([]);
		expect(dedupeCapped(42, { cap: 20 })).toEqual([]);
		expect(dedupeCapped({ 0: 'a', length: 1 }, { cap: 20 })).toEqual([]);
		expect(dedupeCapped(new Set(['a']), { cap: 20 })).toEqual([]);
	});

	it('returns an empty array for an empty array', () => {
		expect(dedupeCapped([], { cap: 20 })).toEqual([]);
	});

	it('never returns the input array itself', () => {
		const input = ['a', 'b'];
		const out = dedupeCapped(input, { cap: 20 });
		expect(out).toEqual(['a', 'b']);
		expect(out).not.toBe(input as unknown as string[]);
	});
});

describe('dedupeCapped — step 2: non-string filtering', () => {
	it('drops every non-string item and keeps string order', () => {
		const out = dedupeCapped(
			[1, 'alpha', null, { a: 1 }, 'beta', undefined, ['x'], true, 'gamma'],
			{ cap: 20 },
		);
		expect(out).toEqual(['alpha', 'beta', 'gamma']);
	});

	it('drops String objects (typeof "object", not "string")', () => {
		// Intentional boxed String: typeof is 'object', so the string filter
		// must drop it rather than persisting a non-primitive into the store.
		const boxed = new String('boxed');
		expect(dedupeCapped([boxed, 'plain'], { cap: 20 })).toEqual(['plain']);
	});

	it('keeps the empty string — it is a string, just an empty one', () => {
		expect(dedupeCapped(['', 'a', ''], { cap: 20 })).toEqual(['', 'a']);
	});
});

describe('dedupeCapped — step 3: per-item truncation', () => {
	it('leaves items untouched when itemMaxChars is omitted', () => {
		const long = 'x'.repeat(500);
		expect(dedupeCapped([long], { cap: 20 })).toEqual([long]);
	});

	it('truncates each item to itemMaxChars', () => {
		const long = 'y'.repeat(500);
		const out = dedupeCapped([long], { cap: 20, itemMaxChars: 200 });
		expect(out).toHaveLength(1);
		expect(out[0]).toHaveLength(200);
		expect(out[0]).toBe('y'.repeat(200));
	});

	it('leaves items shorter than itemMaxChars alone', () => {
		expect(dedupeCapped(['short'], { cap: 20, itemMaxChars: 200 })).toEqual([
			'short',
		]);
	});
});

describe('dedupeCapped — step 4: case-insensitive dedupe, first casing wins', () => {
	it('collapses case variants and preserves the FIRST occurrence casing', () => {
		expect(dedupeCapped(['Bun', 'bun', 'BUN', 'bUn'], { cap: 20 })).toEqual([
			'Bun',
		]);
	});

	it('preserves the first casing even when a later variant is "nicer"', () => {
		expect(dedupeCapped(['tYpEsCrIpT', 'TypeScript'], { cap: 20 })).toEqual([
			'tYpEsCrIpT',
		]);
	});

	it('keeps distinct values in first-seen order', () => {
		expect(
			dedupeCapped(['b', 'a', 'B', 'c', 'A', 'a'], { cap: 20 }),
		).toEqual(['b', 'a', 'c']);
	});

	it('does not collapse values that merely share a prefix', () => {
		expect(dedupeCapped(['run', 'runner', 'running'], { cap: 20 })).toEqual([
			'run',
			'runner',
			'running',
		]);
	});
});

describe('dedupeCapped — step 5: cap keeps the first N survivors', () => {
	it('caps a fully distinct list at exactly `cap` items', () => {
		const input = Array.from({ length: 25 }, (_, i) => `tag-${i}`);
		const out = dedupeCapped(input, { cap: 20 });
		expect(out).toHaveLength(20);
		expect(out[0]).toBe('tag-0');
		expect(out[19]).toBe('tag-19');
		expect(out).not.toContain('tag-20');
	});

	it('returns everything when the input is under the cap', () => {
		expect(dedupeCapped(['a', 'b'], { cap: 20 })).toEqual(['a', 'b']);
	});

	it('returns an empty array for cap 0', () => {
		expect(dedupeCapped(['a', 'b'], { cap: 0 })).toEqual([]);
	});
});

describe('dedupeCapped — pinned ORDER of operations', () => {
	it('truncates BEFORE deduping: truncation can CREATE a duplicate', () => {
		// Two distinct 8-char strings that share the first 5 characters. If dedupe
		// ran before truncation both would survive and the output would be
		// ['abcde', 'abcde'] — a duplicate the caller can observe. Truncating
		// first collapses them to one entry.
		const out = dedupeCapped(['abcdeXXX', 'abcdeYYY'], {
			cap: 20,
			itemMaxChars: 5,
		});
		expect(out).toEqual(['abcde']);
		expect(out).toHaveLength(1);
	});

	it('truncate-then-dedupe is case-insensitive on the TRUNCATED value', () => {
		const out = dedupeCapped(['ABCDEzzz', 'abcdeYYY'], {
			cap: 20,
			itemMaxChars: 5,
		});
		expect(out).toEqual(['ABCDE']);
	});

	it('dedupes BEFORE capping, so duplicates cannot evict distinct values', () => {
		// This is the exact defect: 15 copies of one value followed by 10 distinct
		// values. A positional `.slice(0, 20)` keeps 15 duplicates + only the
		// first 5 distinct values, silently evicting `unique-5`..`unique-9`.
		const input = [
			...Array.from({ length: 15 }, () => 'dup'),
			...Array.from({ length: 10 }, (_, i) => `unique-${i}`),
		];
		const out = dedupeCapped(input, { cap: 20 });

		expect(out).toHaveLength(11);
		expect(out[0]).toBe('dup');
		for (let i = 0; i < 10; i++) {
			expect(out).toContain(`unique-${i}`);
		}
		// The values a bare positional slice would have evicted:
		expect(out).toContain('unique-5');
		expect(out).toContain('unique-9');
	});

	it('caps AFTER dedupe when distinct values still exceed the cap', () => {
		const input = [
			...Array.from({ length: 30 }, (_, i) => `d-${i % 25}`), // 25 distinct
		];
		const out = dedupeCapped(input, { cap: 20 });
		expect(out).toHaveLength(20);
		expect(out[0]).toBe('d-0');
		expect(out[19]).toBe('d-19');
	});

	it('applies all five steps together on hostile mixed input', () => {
		const out = dedupeCapped(
			[
				null,
				'Alpha-LONGTAIL-A',
				'alpha-LONGTAIL-B', // same first 5 chars, different case+tail
				7,
				'Bravo-1',
				'bravo-2',
				'Charlie',
				{ nope: true },
			],
			{ cap: 2, itemMaxChars: 5 },
		);
		// non-strings dropped -> truncate to 5 -> 'Alpha'/'alpha' collapse,
		// 'Bravo'/'bravo' collapse -> cap 2 drops 'Charl'.
		expect(out).toEqual(['Alpha', 'Bravo']);
	});
});
