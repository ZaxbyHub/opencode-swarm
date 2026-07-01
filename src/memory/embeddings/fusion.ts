/**
 * Reciprocal Rank Fusion (RRF) + score normalization for multi-channel
 * memory recall. Pure functions — no I/O, no side effects.
 *
 * RRF formula per channel:
 *   contribution = weight * (1 / (rrfK + rank))
 *
 * where rank is 1-indexed (position + 1) for ids present in that channel;
 * ids absent from a channel contribute 0 from it. Contributions are summed
 * across the three channels for each unique id.
 *
 * The raw fused score is bounded by construction (each RRF term is ≤ 1/rrfK
 * when weight ≤ 1). The final output is min-max normalised across the result
 * set so the top result is always 1.0 and all scores fall in [0, 1].
 *
 * Lexical raw-score normalisation: the lexical channel produces an unnormalised
 * weighted sum whose maximum is the sum of SCORING_WEIGHTS (1.13, see
 * src/memory/scoring.ts:27-37). Callers that need to mix raw lexical scores
 * with other [0,1] signals can use `normalizeLexicalScore`.
 */

/**
 * Sum of all scoring weight coefficients in src/memory/scoring.ts.
 * Dividing a raw lexical score by this value maps it to [0, 1].
 *
 * Derived from SCORING_WEIGHTS:
 *   0.38 + 0.16 + 0.12 + 0.08 + 0.08 + 0.12 + 0.06 + 0.05 + 0.08 = 1.13
 */
export const LEXICAL_WEIGHT_SUM = 1.13;

export interface FusedCandidate {
	id: string;
	fusedScore: number; // normalised to [0, 1]
	lexicalRank: number | null; // 1-indexed, null if absent from lexical ranking
	denseRank: number | null;
	metadataRank: number | null;
}

export interface FusionWeights {
	lexical: number;
	dense: number;
	metadata: number;
}

/**
 * Normalise a raw lexical score to [0, 1] by dividing by LEXICAL_WEIGHT_SUM.
 * The result is clamped so callers never receive an out-of-range value.
 */
export function normalizeLexicalScore(raw: number): number {
	return Math.min(1, Math.max(0, raw / LEXICAL_WEIGHT_SUM));
}

/**
 * Reciprocal Rank Fusion across three ranked id lists.
 *
 * @param lexicalRankedIds   best-first list; position 0 → rank 1
 * @param denseRankedIds     best-first list; position 0 → rank 1
 * @param metadataRankedIds  best-first list; position 0 → rank 1
 * @param weights            per-channel weights
 * @param rrfK               rank-smoothing constant (default 60 in config)
 * @returns FusedCandidate[] sorted by fusedScore descending, scores in [0, 1]
 */
export function fuseRankings(
	lexicalRankedIds: string[],
	denseRankedIds: string[],
	metadataRankedIds: string[],
	weights: FusionWeights,
	rrfK: number,
): FusedCandidate[] {
	// Build per-id rank maps (1-indexed) for each channel.
	const lexicalRanks = buildRankMap(lexicalRankedIds);
	const denseRanks = buildRankMap(denseRankedIds);
	const metadataRanks = buildRankMap(metadataRankedIds);

	// Collect every unique id across all channels.
	const allIds = new Set<string>();
	for (const id of lexicalRankedIds) allIds.add(id);
	for (const id of denseRankedIds) allIds.add(id);
	for (const id of metadataRankedIds) allIds.add(id);

	// Compute raw fused score per id.
	const candidates: FusedCandidate[] = [];
	for (const id of allIds) {
		const lexicalRank = lexicalRanks.get(id) ?? null;
		const denseRank = denseRanks.get(id) ?? null;
		const metadataRank = metadataRanks.get(id) ?? null;

		const rawScore =
			(lexicalRank !== null
				? weights.lexical * rrfTerm(lexicalRank, rrfK)
				: 0) +
			(denseRank !== null ? weights.dense * rrfTerm(denseRank, rrfK) : 0) +
			(metadataRank !== null
				? weights.metadata * rrfTerm(metadataRank, rrfK)
				: 0);

		candidates.push({
			id,
			fusedScore: rawScore,
			lexicalRank,
			denseRank,
			metadataRank,
		});
	}

	// Min-max normalise across the result set so top-1 is exactly 1.0.
	return minMaxNormalise(candidates);
}

function buildRankMap(rankedIds: string[]): Map<string, number> {
	const map = new Map<string, number>();
	for (let i = 0; i < rankedIds.length; i++) {
		// Position is 0-indexed; rank is 1-indexed.
		map.set(rankedIds[i], i + 1);
	}
	return map;
}

function rrfTerm(rank: number, rrfK: number): number {
	return 1 / (rrfK + rank);
}

function minMaxNormalise(candidates: FusedCandidate[]): FusedCandidate[] {
	if (candidates.length === 0) return candidates;

	let min = Infinity;
	let max = -Infinity;
	for (const c of candidates) {
		if (c.fusedScore < min) min = c.fusedScore;
		if (c.fusedScore > max) max = c.fusedScore;
	}

	const range = max - min;
	const normalised: FusedCandidate[] = [];
	for (const c of candidates) {
		const normalisedScore = range === 0 ? 1 : (c.fusedScore - min) / range;
		normalised.push({
			...c,
			fusedScore: normalisedScore,
		});
	}

	// Sort descending by fusedScore; tie-break by id for determinism.
	normalised.sort(
		(a, b) => b.fusedScore - a.fusedScore || a.id.localeCompare(b.id),
	);

	return normalised;
}
