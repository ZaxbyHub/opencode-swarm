/**
 * Pure-function tests for the MMR rerank (Change 5 / Task 6.1).
 * Covers λ=1 (pure relevance), λ=0 (pure diversity), λ=0.5 (balanced), and the
 * paraphrase-crowding property: near-duplicates do not fill the top-K.
 */

import { describe, expect, it } from 'bun:test';
import { _internals } from '../../../src/hooks/search-knowledge.js';

const { mmrRerank, clampLambda } = _internals;

interface E {
	id: string;
	finalScore: number;
	lesson: string;
	created_at: string;
}

function e(id: string, finalScore: number, lesson: string): E {
	return { id, finalScore, lesson, created_at: '2026-01-01T00:00:00.000Z' };
}

describe('clampLambda', () => {
	it('defaults to 0.5 for undefined/NaN', () => {
		expect(clampLambda(undefined)).toBe(0.5);
		expect(clampLambda(Number.NaN)).toBe(0.5);
	});
	it('clamps to [0,1]', () => {
		expect(clampLambda(-1)).toBe(0);
		expect(clampLambda(2)).toBe(1);
		expect(clampLambda(0.3)).toBe(0.3);
	});
});

describe('mmrRerank', () => {
	it('λ=1 (pure relevance) orders strictly by finalScore', () => {
		const pool = [
			e('a', 0.9, 'alpha beta gamma'),
			e('b', 0.7, 'alpha beta gamma'), // near-dup of a, lower score
			e('c', 0.8, 'completely different topic here'),
		];
		const out = mmrRerank(pool, [], 3, 1);
		expect(out.map((x) => x.id)).toEqual(['a', 'c', 'b']);
	});

	it('λ=0 (pure diversity) avoids near-duplicates of already-selected', () => {
		// First pick is the most-different-from-nothing → all sim 0, so the first
		// is chosen by the deterministic tiebreak (highest score). After picking a,
		// b (a near-dup) is maximally penalised, so c (different) comes before b.
		const pool = [
			e('a', 0.9, 'alpha beta gamma delta'),
			e('b', 0.85, 'alpha beta gamma delta'), // near-dup of a
			e('c', 0.4, 'totally unrelated subject matter'),
		];
		const out = mmrRerank(pool, [], 3, 0);
		expect(out[0].id).toBe('a');
		expect(out[1].id).toBe('c'); // diverse beats the near-dup b
		expect(out[2].id).toBe('b');
	});

	it('λ=0.5 keeps at most one of three near-paraphrases in the top-2', () => {
		// Near-IDENTICAL lessons → very high bigram-jaccard, so the diversity
		// penalty dominates the small score gap and a distinct entry surfaces.
		const pool = [
			e('p1', 0.9, 'run the full test suite before completing the phase'),
			e('p2', 0.88, 'run the full test suite before completing the phase now'),
			e(
				'p3',
				0.86,
				'run the full test suite before completing the phase today',
			),
			e('d', 0.5, 'document architectural decisions in the design log'),
		];
		const out = mmrRerank(pool, [], 2, 0.5);
		const ids = out.map((x) => x.id);
		// The diverse 'd' should make the top-2 despite a lower score, and at most
		// one of the three paraphrases appears.
		const paraphrasesInTop = ids.filter((id) => id.startsWith('p')).length;
		expect(paraphrasesInTop).toBeLessThanOrEqual(1);
		expect(ids).toContain('d');
	});

	it('respects the max and counts pinned entries toward it', () => {
		const pinned = [e('pin', 1, 'pinned critical directive')];
		const pool = [e('a', 0.9, 'one'), e('b', 0.8, 'two'), e('c', 0.7, 'three')];
		const out = mmrRerank(pool, pinned, 2, 0.5);
		// max=2, one slot taken by the pinned entry → only 1 from the pool.
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe('a');
	});

	it('is deterministic for uniform paraphrase distance (stable tiebreak)', () => {
		const pool = [
			e('a', 0.5, 'lesson one'),
			e('b', 0.5, 'lesson two'),
			e('c', 0.5, 'lesson three'),
		];
		const a = mmrRerank(pool, [], 3, 0.5).map((x) => x.id);
		const b = mmrRerank([...pool].reverse(), [], 3, 0.5).map((x) => x.id);
		expect(a).toEqual(b); // order independent of input order
	});

	it('returns [] for an empty pool', () => {
		expect(mmrRerank([], [], 5, 0.5)).toEqual([]);
	});
});
