/**
 * Tests for Epic mode's co-change-aware pair conflict predicate.
 * File: tests/unit/epic/cochange-conflict.test.ts
 *
 * Covers:
 *  - Four signal combinations (none / path-only / cochange-only / both).
 *  - Edge cases from design notes §15.6 (empty pairs, empty scopes,
 *    sub-threshold, reverse-order matching, absolute vs relative paths).
 *  - The conservative-combination guarantee: co-change can only ESCALATE.
 */
import { describe, expect, test } from 'bun:test';
import {
	type CoChangeThreshold,
	epicPairConflict,
} from '../../../src/epic/cochange-conflict';
import type { CoChangeEntry } from '../../../src/tools/co-change-analyzer';

const DEFAULT_THRESHOLD: CoChangeThreshold = { npmi: 0.6, minCoChanges: 5 };

/** Helper: build a CoChangeEntry with sensible defaults. */
function entry(
	fileA: string,
	fileB: string,
	npmi: number,
	count = 10,
): CoChangeEntry {
	// Match the canonical ordering that buildCoChangeMatrix produces: fileA < fileB.
	const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA];
	return {
		fileA: a,
		fileB: b,
		coChangeCount: count,
		npmi,
		lift: 1,
		hasStaticEdge: false,
		totalCommits: 100,
		commitsA: 20,
		commitsB: 20,
	};
}

describe('epicPairConflict — signal combinations', () => {
	test('no path overlap and no co-change pairs => no conflict, reason none', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(false);
		expect(v.reason).toBe('none');
		expect(v.evidence.pathPairs).toEqual([]);
		expect(v.evidence.cochangePairs).toEqual([]);
	});

	test('path overlap only => conflict, reason path', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/a.ts'],
			[],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('path');
		expect(v.evidence.pathPairs).toEqual([['src/a.ts', 'src/a.ts']]);
		expect(v.evidence.cochangePairs).toEqual([]);
	});

	test('co-change above threshold only => conflict, reason cochange', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('cochange');
		expect(v.evidence.pathPairs).toEqual([]);
		expect(v.evidence.cochangePairs).toHaveLength(1);
		expect(v.evidence.cochangePairs[0].npmi).toBe(0.9);
	});

	test('path overlap AND co-change above threshold => conflict, reason both', () => {
		// Path overlap on `a`. Independent cochange cross-coupling on (b, c):
		// scopeA exclusively touches b, scopeB exclusively touches c.
		const v = epicPairConflict(
			['src/a.ts', 'src/b.ts'],
			['src/a.ts', 'src/c.ts'],
			[entry('src/b.ts', 'src/c.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('both');
		// pathPairs includes the (a, a) overlap (and possibly other path pairs
		// from the cross-product) — assert at least one is present.
		expect(v.evidence.pathPairs.length).toBeGreaterThan(0);
		expect(v.evidence.cochangePairs).toHaveLength(1);
	});
});

describe('epicPairConflict — threshold gating', () => {
	test('co-change below NPMI threshold does not fire', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.55, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(false);
		expect(v.reason).toBe('none');
	});

	test('co-change below min_co_changes does not fire even with high NPMI', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.99, 3)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(false);
		expect(v.reason).toBe('none');
	});

	test('NPMI exactly at threshold fires (>= comparison)', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.6, 5)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('cochange');
	});
});

describe('epicPairConflict — edge cases (§15.6)', () => {
	test('empty cochangePairs => verdict equals path-only result (greenfield/disabled)', () => {
		// Path conflict path -> still conflict because of path.
		const v1 = epicPairConflict(
			['src/a.ts'],
			['src/a.ts'],
			[],
			DEFAULT_THRESHOLD,
		);
		expect(v1.conflict).toBe(true);
		expect(v1.reason).toBe('path');

		// No path conflict and no co-change data -> no conflict.
		const v2 = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[],
			DEFAULT_THRESHOLD,
		);
		expect(v2.conflict).toBe(false);
		expect(v2.reason).toBe('none');
	});

	test('empty scope on either side => no conflict', () => {
		const pairs = [entry('src/a.ts', 'src/b.ts', 0.9, 20)];
		expect(
			epicPairConflict([], ['src/a.ts'], pairs, DEFAULT_THRESHOLD).conflict,
		).toBe(false);
		expect(
			epicPairConflict(['src/a.ts'], [], pairs, DEFAULT_THRESHOLD).conflict,
		).toBe(false);
		expect(epicPairConflict([], [], pairs, DEFAULT_THRESHOLD).conflict).toBe(
			false,
		);
	});

	test('co-change pair matches regardless of (fileA, fileB) order vs (scopeA, scopeB) order', () => {
		// Pair is stored canonically as (src/a.ts, src/b.ts).
		const pairs = [entry('src/b.ts', 'src/a.ts', 0.9, 20)];

		// scopeA touches a, scopeB touches b -> match.
		const v1 = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			pairs,
			DEFAULT_THRESHOLD,
		);
		expect(v1.conflict).toBe(true);
		expect(v1.reason).toBe('cochange');

		// scopeA touches b, scopeB touches a -> also match.
		const v2 = epicPairConflict(
			['src/b.ts'],
			['src/a.ts'],
			pairs,
			DEFAULT_THRESHOLD,
		);
		expect(v2.conflict).toBe(true);
		expect(v2.reason).toBe('cochange');
	});

	test('absolute scope paths match repo-relative co-change paths via suffix', () => {
		// Lean Turbo's planner prepends `directory` to relative scopes; we must
		// still match against repo-relative co-change file names.
		const v = epicPairConflict(
			['/repo/src/a.ts'],
			['/repo/src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('cochange');
	});

	test('partial name overlap that is not a path-segment match does not fire', () => {
		// scope is `/repo/src/foofoo.ts`, co-change is `src/foo.ts` — must NOT match.
		const v = epicPairConflict(
			['/repo/src/foofoo.ts'],
			['/repo/src/bar.ts'],
			[entry('src/foo.ts', 'src/bar.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(false);
		expect(v.reason).toBe('none');
	});

	test('Windows-style scope paths normalize and still match', () => {
		const v = epicPairConflict(
			['src\\a.ts'],
			['src\\b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('cochange');
	});

	test('multiple co-change pairs: only the matching one contributes evidence', () => {
		const pairs = [
			entry('src/a.ts', 'src/b.ts', 0.9, 20), // matches
			entry('src/c.ts', 'src/d.ts', 0.9, 20), // does not match
			entry('src/x.ts', 'src/y.ts', 0.55, 20), // sub-threshold, excluded
		];
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			pairs,
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.evidence.cochangePairs).toHaveLength(1);
		expect(
			v.evidence.cochangePairs[0].a + '::' + v.evidence.cochangePairs[0].b,
		).toBe('src/a.ts::src/b.ts');
	});

	test('multi-file scopes: any matching pair triggers conflict', () => {
		const pairs = [entry('src/x.ts', 'src/y.ts', 0.9, 20)];
		const v = epicPairConflict(
			['src/a.ts', 'src/x.ts', 'src/c.ts'],
			['src/d.ts', 'src/y.ts'],
			pairs,
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('cochange');
		expect(v.evidence.cochangePairs).toHaveLength(1);
	});
});

describe('epicPairConflict — strict partition (cochange only fires on genuine cross-task coupling)', () => {
	test('pair fully inside scopeA does NOT contribute cochange evidence (only path)', () => {
		// scopeA touches both files of the (a, b) pair; scopeB touches just a.
		// Path conflict on `a` already serializes. The (a, b) coupling lives
		// entirely inside scopeA — it adds no cross-task signal, so cochange
		// must NOT fire and the reason must be 'path', not 'both'.
		const v = epicPairConflict(
			['src/a.ts', 'src/b.ts'],
			['src/a.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('path');
		expect(v.evidence.cochangePairs).toEqual([]);
		expect(v.evidence.pathPairs).toEqual([['src/a.ts', 'src/a.ts']]);
	});

	test('pair fully inside scopeB does NOT contribute cochange evidence (only path)', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/a.ts', 'src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('path');
		expect(v.evidence.cochangePairs).toEqual([]);
	});

	test('pair fully inside both scopes does NOT contribute cochange evidence', () => {
		const v = epicPairConflict(
			['src/a.ts', 'src/b.ts'],
			['src/a.ts', 'src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('path');
		expect(v.evidence.cochangePairs).toEqual([]);
	});

	test('partition is preserved even when no path overlap exists', () => {
		// scopeA touches both a and b; scopeB touches c (no overlap).
		// Pair (a, b) is fully internal to scopeA → no cross-task coupling
		// signal, no path conflict either → verdict is `none`.
		const v = epicPairConflict(
			['src/a.ts', 'src/b.ts'],
			['src/c.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(false);
		expect(v.reason).toBe('none');
	});
});

describe('epicPairConflict — symmetry under scope swap', () => {
	test('swapping scopeA and scopeB does not change the conflict verdict or reason', () => {
		const fixtures: Array<{
			a: string[];
			b: string[];
			pairs: CoChangeEntry[];
		}> = [
			{ a: ['src/a.ts'], b: ['src/b.ts'], pairs: [] },
			{ a: ['src/a.ts'], b: ['src/a.ts'], pairs: [] },
			{
				a: ['src/a.ts'],
				b: ['src/b.ts'],
				pairs: [entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			},
			{
				a: ['src/a.ts', 'src/b.ts'],
				b: ['src/a.ts'],
				pairs: [entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			},
			{
				a: ['/repo/src/x.ts'],
				b: ['/repo/src/y.ts'],
				pairs: [entry('src/x.ts', 'src/y.ts', 0.7, 10)],
			},
		];
		for (const f of fixtures) {
			const ab = epicPairConflict(f.a, f.b, f.pairs, DEFAULT_THRESHOLD);
			const ba = epicPairConflict(f.b, f.a, f.pairs, DEFAULT_THRESHOLD);
			expect(ba.conflict).toBe(ab.conflict);
			expect(ba.reason).toBe(ab.reason);
			expect(ba.evidence.cochangePairs.length).toBe(
				ab.evidence.cochangePairs.length,
			);
		}
	});
});

describe('epicPairConflict — conservative combination invariant', () => {
	test('co-change can never DOWNGRADE a path conflict', () => {
		// Even if cochange "would say no", path conflict still wins.
		// (Co-change has no way to express "no conflict" — its absence is just
		// silence — but we explicitly verify that absence does not flip path.)
		const v = epicPairConflict(
			['src/shared.ts'],
			['src/shared.ts'],
			[], // no cochange evidence at all
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		expect(v.reason).toBe('path');
	});

	test('co-change escalates from no-conflict to conflict', () => {
		const v = epicPairConflict(
			['src/a.ts'],
			['src/b.ts'],
			[entry('src/a.ts', 'src/b.ts', 0.9, 20)],
			DEFAULT_THRESHOLD,
		);
		expect(v.conflict).toBe(true);
		// Without the cochange entry this would be {conflict: false, reason: 'none'}.
		expect(v.reason).toBe('cochange');
	});

	test('verdict shape is stable: reason "none" iff conflict is false', () => {
		const cases: Array<{
			scopeA: string[];
			scopeB: string[];
			pairs: CoChangeEntry[];
		}> = [
			{ scopeA: ['src/a.ts'], scopeB: ['src/b.ts'], pairs: [] },
			{
				scopeA: ['src/a.ts'],
				scopeB: ['src/b.ts'],
				pairs: [entry('src/x.ts', 'src/y.ts', 0.9, 20)],
			},
			{ scopeA: [], scopeB: ['src/a.ts'], pairs: [] },
		];
		for (const c of cases) {
			const v = epicPairConflict(
				c.scopeA,
				c.scopeB,
				c.pairs,
				DEFAULT_THRESHOLD,
			);
			expect(v.conflict).toBe(false);
			expect(v.reason).toBe('none');
		}
	});
});
