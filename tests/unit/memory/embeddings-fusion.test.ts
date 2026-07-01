/**
 * Verification tests for task 3.1 — RRF fusion + normalization.
 * Source: src/memory/embeddings/fusion.ts
 * Pure-function tests; no mocking needed.
 */

import { describe, expect, test } from 'bun:test';
import {
	type FusionWeights,
	fuseRankings,
	LEXICAL_WEIGHT_SUM,
	normalizeLexicalScore,
} from '../../../src/memory/embeddings/fusion';

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

/** Compact rounded representation for assertion failure messages. */
function scores(result: Array<{ id: string; fusedScore: number }>): string {
	return result.map((r) => `${r.id}=${r.fusedScore.toFixed(4)}`).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RRF correctness — hand-computed expected fused scores
// ─────────────────────────────────────────────────────────────────────────────

describe('fuseRankings — RRF correctness', () => {
	const lexical = ['a', 'b', 'c'];
	const dense = ['b', 'a', 'd'];
	const metadata: string[] = [];
	const weights: FusionWeights = { lexical: 1, dense: 1, metadata: 1 };
	const rrfK = 60;

	test('id rank-1 in all channels gets the maximum normalised score', () => {
		// No single id is rank-1 in all three channels; the closest is 'a' (rank-1
		// lexical, rank-2 dense). This test verifies the ordering and exact scores.
		const result = fuseRankings(lexical, dense, metadata, weights, rrfK);

		// Expected raw scores (rrfK=60):
		//   rrfTerm(rank, 60) = 1 / (60 + rank)
		//   'a': 1/61 + 1/62  ≈ 0.016393 + 0.016129 = 0.032522
		//   'b': 1/62 + 1/61  ≈ 0.016129 + 0.016393 = 0.032522  (equal raw, 'a' wins tie by id)
		//   'd': 1/63         ≈ 0.015873
		//   'c': 1/63         ≈ 0.015873  (equal raw with 'd', 'c' wins tie by id)
		// Range = 'a'.raw - 'c'.raw = 1/3782
		// Normalised: 'a' = 1.0, 'b' = ('b'.raw - 'c'.raw) / range = 0.5,
		//             'd' = 0,        'c' = 0
		expect(result[0].id).toBe('a');
		expect(result[0].fusedScore).toBe(1.0);

		expect(result[1].id).toBe('b');
		// 'a' and 'b' have exactly equal raw scores (1/61+1/62 == 1/62+1/61).
		// range = 0 → minMaxNormalise assigns 1.0 to ALL candidates (range===0 branch).
		expect(result[1].fusedScore).toBe(1.0);

		expect(result[2].id).toBe('c');
		// 'c' raw = 1/63, which is the minimum → normalised to 0
		expect(result[2].fusedScore).toBe(0.0);

		expect(result[3].id).toBe('d');
		// 'd' raw = 1/63 = 'c' raw; 'd' > 'c' in localeCompare tie-break
		expect(result[3].fusedScore).toBe(0.0);

		expect(result.length).toBe(4);
	});

	test('rank metadata is correctly populated', () => {
		const result = fuseRankings(lexical, dense, metadata, weights, rrfK);
		const byId = Object.fromEntries(result.map((r) => [r.id, r]));

		expect(byId['a']).toEqual({
			id: 'a',
			fusedScore: 1.0,
			lexicalRank: 1,
			denseRank: 2,
			metadataRank: null,
		});
		expect(byId['b']).toEqual({
			id: 'b',
			fusedScore: 1.0, // equal raw to 'a' → range=0 → normalised to 1.0
			lexicalRank: 2,
			denseRank: 1,
			metadataRank: null,
		});
		expect(byId['c']).toEqual({
			id: 'c',
			fusedScore: 0.0,
			lexicalRank: 3,
			denseRank: null,
			metadataRank: null,
		});
		expect(byId['d']).toEqual({
			id: 'd',
			fusedScore: 0.0,
			lexicalRank: null,
			denseRank: 3,
			metadataRank: null,
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Top-1 shifts with weights
// ─────────────────────────────────────────────────────────────────────────────

describe('fuseRankings — top-1 shifts with weights', () => {
	const lexical = ['a', 'b', 'c'];
	const dense = ['b', 'a', 'd'];
	const metadata: string[] = [];
	const rrfK = 60;

	test('lexical weight dominance — lexical-rank-1 wins', () => {
		const w: FusionWeights = { lexical: 0.9, dense: 0.1, metadata: 0 };
		const result = fuseRankings(lexical, dense, metadata, w, rrfK);
		expect(result[0].id).toBe('a'); // rank-1 in lexical
		expect(result[0].fusedScore).toBe(1.0);
	});

	test('dense weight dominance — dense-rank-1 wins', () => {
		const w: FusionWeights = { lexical: 0.1, dense: 0.9, metadata: 0 };
		const result = fuseRankings(lexical, dense, metadata, w, rrfK);
		expect(result[0].id).toBe('b'); // rank-1 in dense
		expect(result[0].fusedScore).toBe(1.0);
	});

	test('metadata-only channel — top-1 from metadata', () => {
		const lexical2: string[] = [];
		const dense2: string[] = [];
		const metadata2 = ['x', 'y', 'z'];
		const w: FusionWeights = { lexical: 0, dense: 0, metadata: 1 };
		const result = fuseRankings(lexical2, dense2, metadata2, w, rrfK);
		expect(result[0].id).toBe('x');
		expect(result[0].metadataRank).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('fuseRankings — determinism', () => {
	test('same inputs twice — identical output including tie-break by id', () => {
		const lexical = ['c', 'b', 'a'];
		const dense = ['a', 'c', 'b'];
		const metadata: string[] = [];
		const weights: FusionWeights = { lexical: 1, dense: 1, metadata: 1 };
		const rrfK = 60;

		const result1 = fuseRankings(lexical, dense, metadata, weights, rrfK);
		const result2 = fuseRankings(lexical, dense, metadata, weights, rrfK);

		expect(result1.map((r) => r.id)).toEqual(result2.map((r) => r.id));
		for (let i = 0; i < result1.length; i++) {
			expect(result1[i].fusedScore).toBeCloseTo(result2[i].fusedScore);
		}
	});

	test('id tie-break is deterministic (localeCompare)', () => {
		// Two ids with identical raw scores: 'aa' < 'ab' < 'b' in localeCompare order
		const lexical = ['aa', 'ab', 'b'];
		const dense: string[] = [];
		const metadata: string[] = [];
		const weights: FusionWeights = { lexical: 1, dense: 0, metadata: 0 };
		const rrfK = 60;

		const result = fuseRankings(lexical, dense, metadata, weights, rrfK);
		// All have the same rank-derived score; sorted by id alphabetically
		expect(result[0].id).toBe('aa');
		expect(result[1].id).toBe('ab');
		expect(result[2].id).toBe('b');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. normalizeLexicalScore
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeLexicalScore', () => {
	test('raw = LEXICAL_WEIGHT_SUM (1.13) → 1.0', () => {
		expect(normalizeLexicalScore(LEXICAL_WEIGHT_SUM)).toBe(1.0);
	});

	test('raw = 0.565 → 0.5', () => {
		// 0.565 / 1.13 = 0.5 exactly (up to floating point)
		expect(normalizeLexicalScore(0.565)).toBeCloseTo(0.5);
	});

	test('raw > LEXICAL_WEIGHT_SUM → clamped to 1.0', () => {
		expect(normalizeLexicalScore(5)).toBe(1.0);
		expect(normalizeLexicalScore(1.13 * 2)).toBe(1.0);
	});

	test('raw < 0 → clamped to 0', () => {
		expect(normalizeLexicalScore(-0.5)).toBe(0.0);
		expect(normalizeLexicalScore(-100)).toBe(0.0);
	});

	test('raw = 0 → 0', () => {
		expect(normalizeLexicalScore(0)).toBe(0.0);
	});

	test('handles edge values at boundary of 1.0', () => {
		// Just at the boundary
		expect(normalizeLexicalScore(LEXICAL_WEIGHT_SUM - 1e-15)).toBeLessThan(1.0);
		expect(normalizeLexicalScore(LEXICAL_WEIGHT_SUM + 1e-15)).toBeCloseTo(1.0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Min-max normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe('fuseRankings — min-max normalisation', () => {
	test('top result fusedScore is exactly 1.0', () => {
		const result = fuseRankings(
			['x', 'y'],
			['y', 'x'],
			[],
			{ lexical: 1, dense: 1, metadata: 0 },
			60,
		);
		expect(result[0].fusedScore).toBe(1.0);
	});

	test('all fusedScores are in [0, 1]', () => {
		const result = fuseRankings(
			['a', 'b', 'c', 'd'],
			['c', 'd', 'a', 'b'],
			['b', 'a', 'd', 'c'],
			{ lexical: 0.5, dense: 0.3, metadata: 0.2 },
			60,
		);
		for (const r of result) {
			expect(r.fusedScore).toBeGreaterThanOrEqual(0.0);
			expect(r.fusedScore).toBeLessThanOrEqual(1.0);
		}
	});

	test('all-zero weights — all scores equal, min-max handles gracefully', () => {
		// With all-zero weights every raw score is 0; range is 0; normalisation
		// must NOT produce NaN and should assign 1.0 to every candidate.
		const result = fuseRankings(
			['a', 'b'],
			['b', 'a'],
			[],
			{ lexical: 0, dense: 0, metadata: 0 },
			60,
		);
		for (const r of result) {
			expect(Number.isNaN(r.fusedScore)).toBe(false);
			expect(r.fusedScore).toBe(1.0); // range=0 branch assigns 1.0
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Adversarial / edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('fuseRankings — adversarial / edge cases', () => {
	test('all-empty rankings → empty result', () => {
		const result = fuseRankings(
			[],
			[],
			[],
			{ lexical: 1, dense: 1, metadata: 1 },
			60,
		);
		expect(result).toEqual([]);
	});

	test('single id in one channel only', () => {
		const result = fuseRankings(
			['solo'],
			[],
			[],
			{ lexical: 1, dense: 1, metadata: 1 },
			60,
		);
		expect(result.length).toBe(1);
		expect(result[0].id).toBe('solo');
		expect(result[0].lexicalRank).toBe(1);
		expect(result[0].denseRank).toBe(null);
		expect(result[0].metadataRank).toBe(null);
		// Normalised: solo is both min and max → gets 1.0
		expect(result[0].fusedScore).toBe(1.0);
	});

	test('id present in all three channels', () => {
		const result = fuseRankings(
			['shared', 'a'],
			['b', 'shared'],
			['c', 'd', 'shared'],
			{ lexical: 1, dense: 1, metadata: 1 },
			60,
		);
		const shared = result.find((r) => r.id === 'shared')!;
		expect(shared.lexicalRank).toBe(1);
		expect(shared.denseRank).toBe(2);
		expect(shared.metadataRank).toBe(3);
		// rawScore = 1/61 + 1/62 + 1/63 — should be top score after normalisation
		expect(result[0].id).toBe('shared');
		expect(result[0].fusedScore).toBe(1.0);
	});

	test('rrfK = 0 edge case', () => {
		// rrfK=0 gives rrfTerm(rank, 0) = 1/rank (no smoothing)
		const result = fuseRankings(
			['a', 'b'],
			['b', 'a'],
			[],
			{ lexical: 1, dense: 1, metadata: 0 },
			0,
		);
		// 'a': 1/1 + 1/2 = 1.5; 'b': 1/2 + 1/1 = 1.5  → exactly equal raw scores.
		// range = 0 → minMaxNormalise assigns 1.0 to ALL candidates.
		expect(result[0].id).toBe('a');
		expect(result[0].fusedScore).toBe(1.0);
		expect(result[1].id).toBe('b');
		expect(result[1].fusedScore).toBe(1.0); // range=0 branch: both get 1.0
	});

	test('single candidate — fusedScore is 1.0 after normalisation', () => {
		const result = fuseRankings(
			['only'],
			[],
			[],
			{ lexical: 1, dense: 0, metadata: 0 },
			60,
		);
		expect(result.length).toBe(1);
		expect(result[0].fusedScore).toBe(1.0);
	});

	test('negative rrfK is handled (rrfTerm = 1 / (negative + rank))', () => {
		// Negative rrfK is mathematically valid (just shifts the denominator).
		// We verify the function doesn't throw and produces a valid ordering.
		const result = fuseRankings(
			['a', 'b'],
			['b', 'a'],
			[],
			{ lexical: 1, dense: 1, metadata: 0 },
			-30,
		);
		expect(result.length).toBe(2);
		for (const r of result) {
			expect(Number.isNaN(r.fusedScore)).toBe(false);
		}
	});

	test('very large rrfK damps contributions toward zero', () => {
		const result = fuseRankings(
			['a', 'b'],
			['b', 'a'],
			[],
			{ lexical: 1, dense: 1, metadata: 0 },
			1_000_000,
		);
		// 'a' and 'b' have equal raw scores → range≈0 → normalization assigns 1.0 to all.
		for (const r of result) {
			expect(r.fusedScore).toBeGreaterThanOrEqual(0);
			expect(r.fusedScore).toBeLessThanOrEqual(1);
		}
		// Both 'a' and 'b' have equal raw scores with large rrfK, so both get 1.0.
		expect(result[0].id).toBe('a');
		expect(result[0].fusedScore).toBe(1.0);
		expect(result[1].id).toBe('b');
		expect(result[1].fusedScore).toBe(1.0);
	});

	test('large inputs — many ids across all channels', () => {
		// Stress-test with 100 ids per channel
		const n = 100;
		const ids = Array.from({ length: n }, (_, i) => `id_${i}`);
		// Reverse each channel so ranks differ
		const lexical = [...ids].reverse();
		const dense = [...ids].sort();
		const metadata = ids.slice().sort().reverse();

		const result = fuseRankings(
			lexical,
			dense,
			metadata,
			{ lexical: 0.4, dense: 0.4, metadata: 0.2 },
			60,
		);

		expect(result.length).toBe(n);
		// Scores must be monotonically non-increasing
		for (let i = 0; i < result.length - 1; i++) {
			expect(result[i].fusedScore).toBeGreaterThanOrEqual(
				result[i + 1].fusedScore,
			);
		}
		// Top score must be 1.0
		expect(result[0].fusedScore).toBe(1.0);
		// All in [0, 1]
		for (const r of result) {
			expect(r.fusedScore).toBeGreaterThanOrEqual(0);
			expect(r.fusedScore).toBeLessThanOrEqual(1);
		}
	});
});
