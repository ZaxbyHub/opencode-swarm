/**
 * #3572 N-12 re-pins for the W7 per-interpreter cluster grammar, relocated
 * from `src/hooks/shell-write-detect.test.ts` to respect the FR-006 no-growth
 * ratchet on that over-cap reference suite: the W7 grammar decomposes `-pe`
 * into an interpreter_eval capability (the -p loop wraps the -e code), so
 * `perl -i -pe` emits BOTH writes and bare `perl -pe` is no longer
 * write-free (perl 5.36 ground truth; closes the last of the four CI-red
 * families the #3572 review census found).
 */
import { describe, expect, test } from 'bun:test';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';

const evalWrite = (
	operator: string,
): {
	category: 'interpreter_eval';
	operator: string;
	path: null;
	capability: true;
} => ({ category: 'interpreter_eval', operator, path: null, capability: true });

describe('#3572 N-12: perl W7 cluster capability re-pins', () => {
	test('perl -i -pe emits the in-place write AND the eval capability', () => {
		const result = detectPosixWrites('perl -i -pe "s/foo/bar/" data.csv');
		expect(result.writes).toEqual([
			{ category: 'inplace_edit', operator: 'perl -i', path: 'data.csv' },
			evalWrite('perl [eval]'),
		]);
	});

	test('bare perl -pe evaluates inline code (no longer write-free)', () => {
		const result = detectPosixWrites('perl -pe "print" file.txt');
		expect(result.hasWrites).toBe(true);
		expect(result.writes).toEqual([evalWrite('perl [eval]')]);
	});
});
