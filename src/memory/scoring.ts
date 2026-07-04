import type { QLearningConfig } from './config';
import { DEFAULT_QLEARNING_CONFIG } from './config';
import { getQValue } from './q-learning';
import { resolveMemoryRecallProfile } from './role-profiles';
import { isExpired, stableScopeKey } from './schema';
import type {
	MemoryKind,
	MemoryRecord,
	MemoryScopeRef,
	RecallRequest,
	RecallResultItem,
} from './types';

/**
 * Neutral q-value (no learned signal yet) — matches
 * `DEFAULT_QLEARNING_CONFIG.initialQValue` (A.3) and `getQValue`'s own
 * default fallback. A record at this value contributes zero to the
 * q-value ranking boost (see `qValueBoost` in `scoreMemoryRecordDetailed`).
 */
const NEUTRAL_Q_VALUE = 0.5;

export interface RecallScoringDiagnostics {
	candidateCount: number;
	preScoredFilteredCount: number;
	scoredCount: number;
	returnedCount: number;
	noSignalCount: number;
	belowThresholdCount: number;
	/** Count of records skipped via the A.6 low-q suppression filter (FR-006/SC-007). */
	suppressedLowQCount: number;
	/**
	 * 0 or 1 — whether the C.1 active-exploration layer resurfaced a
	 * suppressed candidate this recall (FR-014/SC-016). At most one per
	 * recall by design; see `scoreMemoryRecordsWithDiagnostics`.
	 */
	exploredCount: number;
	fusionActive?: boolean;
}

/**
 * Recall scoring weight coefficients. Sum is 1.13 (scores are an unnormalised
 * weighted sum; may exceed 1.0). minScore thresholds in DEFAULT_MEMORY_CONFIG
 * are calibrated against these weights.
 *
 * Pinned by tests/unit/memory/scoring.test.ts to detect drift.
 *
 * A.5 note: the learned-utility (q-value) term is intentionally NOT part of
 * this static table. Its weight is `qLearning.qValueBoostWeight` (config,
 * default 0.10) so it stays user-tunable, and its contribution is CENTERED
 * on the neutral q-value (see `NEUTRAL_Q_VALUE`) rather than a flat add — a
 * neutral-q record contributes 0, so the max score impact is
 * `±0.10 * 0.5 = ±0.05`, not a flat `+0.10`. It only affects ranking order,
 * never the `minScore` inclusion cutoff (FR-005 / SC-006).
 */
export const SCORING_WEIGHTS = {
	textOverlap: 0.38,
	tagOverlap: 0.16,
	fileOverlap: 0.12,
	symbolOverlap: 0.08,
	taskTermOverlap: 0.08,
	scopeSpecificityBoost: 0.12,
	kindProfileBoost: 0.06,
	roleBoost: 0.05,
	confidence: 0.08,
} as const;

interface RecallScoringContext {
	taskTokens?: Set<string>;
	queryTokens: Set<string>;
	roleProfileKinds?: Set<MemoryKind>;
}

export function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\w\s-]/g, ' ')
			.split(/\s+/)
			.map((token) => token.trim())
			.filter(Boolean),
	);
}

/**
 * True Jaccard similarity |A∩B| / |A∪B| over two token sets. Distinct from the
 * recall-scoring `overlap` helper (which is a precision-like |A∩B|/max(|A|,|B|)).
 * Consolidation clustering uses Jaccard per the issue spec (threshold 0.30).
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Single-pass greedy lexical clustering by Jaccard token overlap. Each item is
 * compared against the representative (first member) of each existing cluster;
 * it joins the first cluster whose representative meets `threshold`, else seeds
 * a new cluster. Deterministic for a given input order. Sufficient for v1
 * (embedding-based clustering is Phase 4, out of scope).
 */
export function clusterByJaccard<T>(
	items: T[],
	getText: (item: T) => string,
	threshold: number,
): T[][] {
	const clusters: { tokens: Set<string>; members: T[] }[] = [];
	for (const item of items) {
		const tokens = tokenize(getText(item));
		let placed = false;
		for (const cluster of clusters) {
			if (jaccard(tokens, cluster.tokens) >= threshold) {
				cluster.members.push(item);
				placed = true;
				break;
			}
		}
		if (!placed) {
			clusters.push({ tokens, members: [item] });
		}
	}
	return clusters.map((cluster) => cluster.members);
}

/**
 * Continuous importance score in [0, sum-of-weights]. Replaces the boolean
 * `isLowUtility` heuristic (DD-11). Implements the issue formula:
 *
 *   importance = w_recency  · exp(-λ · days_since_last_recall)
 *              + w_frequency · log1p(retrieval_count) / log1p(N)
 *              + w_freshness · exp(-μ · days_since_created)
 *              + w_confidence · confidence
 *
 * A never-recalled memory contributes 0 to the recency and frequency terms
 * (days_since_last_recall is null, retrieval_count is 0), so for never-recalled
 * items importance is driven by freshness and confidence — which is exactly why
 * a high-confidence, never-recalled, aged memory is no longer mislabeled
 * low-utility under the old OR condition.
 */
export interface ImportanceWeights {
	wRecency: number;
	wFrequency: number;
	wFreshness: number;
	wConfidence: number;
	lambda: number;
	mu: number;
	n: number;
}

export function importanceScore(
	input: {
		confidence: number;
		retrievalCount: number;
		daysSinceLastRecall: number | null;
		daysSinceCreated: number;
	},
	weights: ImportanceWeights,
): number {
	const recency =
		input.daysSinceLastRecall === null
			? 0
			: Math.exp(-weights.lambda * Math.max(0, input.daysSinceLastRecall));
	const denom = Math.log1p(Math.max(1, weights.n));
	const frequency =
		denom === 0 ? 0 : Math.log1p(Math.max(0, input.retrievalCount)) / denom;
	const freshness = Math.exp(-weights.mu * Math.max(0, input.daysSinceCreated));
	const confidence = Math.min(1, Math.max(0, input.confidence));
	return (
		weights.wRecency * recency +
		weights.wFrequency * frequency +
		weights.wFreshness * freshness +
		weights.wConfidence * confidence
	);
}

function normalizeKindText(kind: MemoryKind): string {
	return kind.replace(/_/g, ' ');
}

function collectMetadataStrings(
	metadata: Record<string, unknown>,
	keys: string[],
): string[] {
	const values: string[] = [];
	for (const key of keys) {
		const value = metadata[key];
		if (typeof value === 'string') values.push(value);
		if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === 'string') values.push(item);
			}
		}
	}
	return values;
}

function overlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let hits = 0;
	for (const token of a) {
		if (b.has(token)) hits++;
	}
	return hits / Math.max(a.size, 1);
}

function scopeSpecificityBoost(scope: MemoryScopeRef): number {
	switch (scope.type) {
		case 'agent':
			return 1;
		case 'run':
			return 0.9;
		case 'repository':
			return 0.8;
		case 'project':
			return 0.65;
		case 'workspace':
			return 0.45;
		case 'global_user':
			return 0.3;
	}
}

function kindProfileBoost(kind: MemoryKind, request: RecallRequest): number {
	if (!request.kinds || request.kinds.length === 0) return 0.5;
	return request.kinds.includes(kind) ? 1 : 0;
}

function roleProfileBoost(
	kind: MemoryKind,
	context: RecallScoringContext,
): number {
	return context.roleProfileKinds?.has(kind) ? 1 : 0;
}

export function sameScope(a: MemoryScopeRef, b: MemoryScopeRef): boolean {
	return stableScopeKey(a) === stableScopeKey(b);
}

export function scopeAllowed(
	recordScope: MemoryScopeRef,
	allowedScopes: MemoryScopeRef[],
): boolean {
	return allowedScopes.some((scope) => sameScope(recordScope, scope));
}

export function scoreMemoryRecord(
	record: MemoryRecord,
	request: RecallRequest,
	qLearningConfig: QLearningConfig = DEFAULT_QLEARNING_CONFIG,
): RecallResultItem | null {
	const result = scoreMemoryRecordDetailed(
		record,
		request,
		createScoringContext(request),
		qLearningConfig,
	);
	return result.item;
}

function scoreMemoryRecordDetailed(
	record: MemoryRecord,
	request: RecallRequest,
	context: RecallScoringContext,
	qLearningConfig: QLearningConfig = DEFAULT_QLEARNING_CONFIG,
): {
	item: RecallResultItem | null;
	skipReason?: 'filtered' | 'no_signal' | 'suppressed_low_q';
	/**
	 * The 9-signal score WITHOUT the q-value boost. `minScore` inclusion is
	 * gated on this value (not `item.score`) so the q-term can only affect
	 * ranking order among already-included memories, never inclusion itself
	 * (FR-005 / SC-006).
	 */
	baseScore?: number;
} {
	if (!request.includeExpired && isExpired(record)) {
		return { item: null, skipReason: 'filtered' };
	}
	if (record.supersededBy) return { item: null, skipReason: 'filtered' };
	if (record.metadata.deleted === true) {
		return { item: null, skipReason: 'filtered' };
	}
	if (!scopeAllowed(record.scope, request.scopes)) {
		return { item: null, skipReason: 'filtered' };
	}
	if (request.kinds && !request.kinds.includes(record.kind)) {
		return { item: null, skipReason: 'filtered' };
	}
	// A.6 (FR-006/SC-007): suppress proven-low-utility memories from default
	// recall. This is a pure recall-time omission — the record is never
	// mutated or tombstoned, and the caller can opt back in via
	// `includeLowQ`. Strict `<` so a record exactly at the threshold is NOT
	// suppressed. Distinct from the A.5 q-value ranking boost below (which
	// never excludes); this filter deliberately excludes.
	if (
		request.includeLowQ !== true &&
		getQValue(record, qLearningConfig.initialQValue) <
			qLearningConfig.suppressionThreshold
	) {
		return { item: null, skipReason: 'suppressed_low_q' };
	}

	const queryTokens =
		request.mode === 'injection' && context.taskTokens
			? context.taskTokens
			: context.queryTokens;
	const textTokens = tokenize(record.text);
	const tagTokens = tokenize(record.tags.join(' '));
	const fileTokens = tokenize(
		[
			record.source.filePath,
			...collectMetadataStrings(record.metadata, [
				'file',
				'filePath',
				'files',
				'touchedFiles',
			]),
		]
			.filter((value): value is string => typeof value === 'string')
			.join(' '),
	);
	const symbolTokens = tokenize(
		collectMetadataStrings(record.metadata, ['symbol', 'symbols']).join(' '),
	);
	const kindTokens = tokenize(normalizeKindText(record.kind));
	const sourceRefTokens = tokenize(record.source.ref ?? '');
	const taskSearchTokens = unionTokens(
		textTokens,
		tagTokens,
		fileTokens,
		symbolTokens,
		kindTokens,
		sourceRefTokens,
	);
	const taskTermOverlap = context.taskTokens
		? overlap(context.taskTokens, taskSearchTokens)
		: 0;
	const kindQueryOverlap = overlap(queryTokens, kindTokens);
	const textOverlap = overlap(queryTokens, textTokens);
	const tagOverlap = overlap(queryTokens, tagTokens);
	const fileOverlap = overlap(queryTokens, fileTokens);
	const symbolOverlap = overlap(queryTokens, symbolTokens);
	const kindMatch = request.kinds?.includes(record.kind) ?? false;
	const scopeMatch = scopeAllowed(record.scope, request.scopes);
	const roleBoost = roleProfileBoost(record.kind, context);
	const hasQuerySignal =
		textOverlap > 0 ||
		tagOverlap > 0 ||
		fileOverlap > 0 ||
		symbolOverlap > 0 ||
		kindQueryOverlap > 0;

	if (
		request.mode === 'injection' &&
		request.requireQuerySignal !== false &&
		!hasQuerySignal
	) {
		return { item: null, skipReason: 'no_signal' };
	}

	const baseScore =
		textOverlap * SCORING_WEIGHTS.textOverlap +
		tagOverlap * SCORING_WEIGHTS.tagOverlap +
		fileOverlap * SCORING_WEIGHTS.fileOverlap +
		symbolOverlap * SCORING_WEIGHTS.symbolOverlap +
		taskTermOverlap * SCORING_WEIGHTS.taskTermOverlap +
		scopeSpecificityBoost(record.scope) *
			SCORING_WEIGHTS.scopeSpecificityBoost +
		kindProfileBoost(record.kind, request) * SCORING_WEIGHTS.kindProfileBoost +
		roleBoost * SCORING_WEIGHTS.roleBoost +
		record.confidence * SCORING_WEIGHTS.confidence;

	// A.5: learned-utility (q-value) ranking term. Centered on the neutral
	// q-value so a never-scored (neutral) memory contributes exactly 0 — this
	// is what makes the term mildly favor/disfavor rather than flatly boost
	// every memory. Bounded to [-0.5, +0.5] * qValueBoostWeight, applied only
	// to the RANKING score below (never to `baseScore`, which gates
	// inclusion) so it can only reorder results, never exclude or rescue one
	// (FR-005 / SC-006).
	const qValue = getQValue(record, NEUTRAL_Q_VALUE);
	const qValueBoost =
		(qValue - NEUTRAL_Q_VALUE) * qLearningConfig.qValueBoostWeight;
	const rankingScore = baseScore + qValueBoost;

	const reasonParts = [
		textOverlap > 0 ? `text_overlap=${textOverlap.toFixed(2)}` : null,
		tagOverlap > 0 ? `tag_overlap=${tagOverlap.toFixed(2)}` : null,
		fileOverlap > 0 ? `file_overlap=${fileOverlap.toFixed(2)}` : null,
		symbolOverlap > 0 ? `symbol_overlap=${symbolOverlap.toFixed(2)}` : null,
		taskTermOverlap > 0 ? `task_terms=${taskTermOverlap.toFixed(2)}` : null,
		kindQueryOverlap > 0 ? `kind_query=${kindQueryOverlap.toFixed(2)}` : null,
		roleBoost > 0 ? 'role_profile' : null,
		`scope=${record.scope.type}`,
		`confidence=${record.confidence.toFixed(2)}`,
		qValue !== NEUTRAL_Q_VALUE ? `qvalue=${qValue.toFixed(2)}` : null,
	].filter(Boolean);

	return {
		baseScore,
		item: {
			record,
			score: rankingScore,
			reason: reasonParts.join(', '),
			signals: {
				textOverlap,
				tagOverlap,
				fileOverlap,
				symbolOverlap,
				kindMatch,
				scopeMatch,
			},
		},
	};
}

export function scoreMemoryRecords(
	records: MemoryRecord[],
	request: RecallRequest,
	qLearningConfig: QLearningConfig = DEFAULT_QLEARNING_CONFIG,
): RecallResultItem[] {
	return scoreMemoryRecordsWithDiagnostics(records, request, qLearningConfig)
		.items;
}

export interface ScoreMemoryRecordsOptions {
	/**
	 * RNG seam for the C.1 active-exploration draw (FR-014/SC-016). Defaults
	 * to `Math.random`. Tests inject a deterministic function — `() => 0`
	 * forces exploration (for any `explorationRate > 0`), `() => 0.99` forces
	 * none (for the default `explorationRate` of 0.05) — so exploration is
	 * unit-testable without depending on real randomness.
	 */
	random?: () => number;
}

export function scoreMemoryRecordsWithDiagnostics(
	records: MemoryRecord[],
	request: RecallRequest,
	qLearningConfig: QLearningConfig = DEFAULT_QLEARNING_CONFIG,
	options?: ScoreMemoryRecordsOptions,
): { items: RecallResultItem[]; diagnostics: RecallScoringDiagnostics } {
	const minScore = request.minScore ?? 0;
	const context = createScoringContext(request);
	const diagnostics: RecallScoringDiagnostics = {
		candidateCount: records.length,
		preScoredFilteredCount: 0,
		scoredCount: 0,
		returnedCount: 0,
		noSignalCount: 0,
		belowThresholdCount: 0,
		suppressedLowQCount: 0,
		exploredCount: 0,
	};
	const items: RecallResultItem[] = [];
	// C.1: records suppressed by the A.6 filter above, tracked so the
	// exploration layer below can pick a candidate to resurrect WITHOUT
	// weakening `scoreMemoryRecordDetailed`'s own suppression check — that
	// per-record filter still runs unconditionally for every record.
	const suppressedRecords: MemoryRecord[] = [];

	for (const record of records) {
		const result = scoreMemoryRecordDetailed(
			record,
			request,
			context,
			qLearningConfig,
		);
		if (!result.item) {
			if (result.skipReason === 'filtered')
				diagnostics.preScoredFilteredCount++;
			if (result.skipReason === 'no_signal') diagnostics.noSignalCount++;
			if (result.skipReason === 'suppressed_low_q') {
				diagnostics.suppressedLowQCount++;
				suppressedRecords.push(record);
			}
			continue;
		}
		diagnostics.scoredCount++;
		// Inclusion is gated on the BASE score (pre-q-boost), never the
		// boosted ranking score — the q-term must not exclude a memory by
		// itself, nor rescue one that fails on its own merits (FR-005 / SC-006).
		const baseScore = result.baseScore ?? result.item.score;
		if (baseScore < minScore) {
			diagnostics.belowThresholdCount++;
			continue;
		}
		items.push(result.item);
	}

	// C.1 (FR-014/SC-016): active exploration of suppressed memories. This is
	// an explicit, bounded resurrection layered ON TOP of the A.6 filter
	// above — it never runs for `includeLowQ: true` callers (who already see
	// every low-q record via the normal path, so there is nothing left to
	// "explore") and never fires when nothing was suppressed this recall.
	if (
		request.includeLowQ !== true &&
		suppressedRecords.length > 0 &&
		qLearningConfig.explorationRate > 0
	) {
		const draw = (options?.random ?? Math.random)();
		if (draw < qLearningConfig.explorationRate) {
			// Deterministic pick: highest baseScore among suppressed candidates
			// that would ALSO clear this recall's own gates (query-signal
			// requirement, minScore) once suppression itself is set aside —
			// exploration must never surface pure noise, only the most
			// promising suppressed candidate. Recomputed via `includeLowQ:
			// true` so the per-record filter (untouched above) is bypassed
			// only for this deliberate, bounded resurrection.
			const exploreRequest: RecallRequest = { ...request, includeLowQ: true };
			let best: { item: RecallResultItem; baseScore: number } | null = null;
			for (const record of suppressedRecords) {
				const rescored = scoreMemoryRecordDetailed(
					record,
					exploreRequest,
					context,
					qLearningConfig,
				);
				if (!rescored.item) continue;
				const baseScore = rescored.baseScore ?? rescored.item.score;
				if (baseScore < minScore) continue;
				const isBetter =
					!best ||
					baseScore > best.baseScore ||
					(baseScore === best.baseScore &&
						record.id.localeCompare(best.item.record.id) < 0);
				if (isBetter) {
					best = { item: rescored.item, baseScore };
				}
			}
			// At most ONE explored item per recall — never more, regardless of
			// how many candidates were suppressed.
			if (best) {
				items.push({ ...best.item, explored: true });
				diagnostics.exploredCount = 1;
			}
		}
	}

	items.sort(
		(a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
	);
	diagnostics.returnedCount = items.length;
	return { items, diagnostics };
}

/**
 * Applies the recall `maxItems` cap ADDITIVELY with respect to the C.1
 * active-exploration item (FR-014/SC-016 reviewer fix). Normal (non-explored)
 * items are capped at `maxItems` in their existing order; the single
 * `explored: true` item (if present in `items`) is then appended AFTER the
 * cap, beyond `maxItems`.
 *
 * This guarantees bounded exploration can never evict a legitimate ranked
 * hit: a recall can return at most `maxItems` normal hits plus (at most) one
 * explored item — never fewer normal hits because an explored candidate
 * displaced one within the cap. Every provider recall-slicing site
 * (`sqlite-provider.ts`, `local-jsonl-provider.ts`) must use this helper
 * instead of a plain `.slice(0, maxItems)` so exploration stays additive
 * everywhere `maxItems` is enforced.
 *
 * SCOPE OF THE GUARANTEE (reviewer note, known limitation G-3): additivity is
 * strict at THIS slice. On the opt-in embeddings/RRF fusion path the explored
 * item participates in `fuseRankings` as an ordinary lexical candidate BEFORE
 * this slice (`sqlite-provider.ts`), and because exploration deliberately picks
 * the highest-baseScore suppressed record, it can out-rank a normal hit by one
 * lexical position; after `minMaxNormalise` a normal item sitting exactly on
 * the fusion `minScore` boundary can then fall below the Stage-5 re-gate
 * BECAUSE the explored item was present. That is a marginal RRF reshuffle
 * upstream of the slice, not an eviction at the slice. Making additivity strict
 * through fusion too would require excluding `explored` items from
 * `fuseRankings` and re-injecting them only here — deferred with G-1/G-2 to the
 * injection-path/fusion enhancement (fixing it alone is moot while G-2 gates
 * the dominant injection path).
 */
export function sliceRecallItemsWithExploration(
	items: RecallResultItem[],
	maxItems: number,
): RecallResultItem[] {
	const normal = items.filter((item) => !item.explored);
	const explored = items.filter((item) => item.explored);
	return [...normal.slice(0, maxItems), ...explored];
}

function createScoringContext(request: RecallRequest): RecallScoringContext {
	const taskTokens = request.task ? tokenize(request.task) : undefined;
	return {
		taskTokens,
		queryTokens: tokenize(request.query),
		roleProfileKinds: request.agentRole
			? new Set(resolveMemoryRecallProfile(request.agentRole).kinds)
			: undefined,
	};
}

function unionTokens(...sets: Set<string>[]): Set<string> {
	const union = new Set<string>();
	for (const set of sets) {
		for (const token of set) union.add(token);
	}
	return union;
}
