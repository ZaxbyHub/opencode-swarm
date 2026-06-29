import { resolveMemoryRecallProfile } from './role-profiles';
import { isExpired, stableScopeKey } from './schema';
import type {
	MemoryKind,
	MemoryRecord,
	MemoryScopeRef,
	RecallRequest,
	RecallResultItem,
} from './types';

export interface RecallScoringDiagnostics {
	candidateCount: number;
	preScoredFilteredCount: number;
	scoredCount: number;
	returnedCount: number;
	noSignalCount: number;
	belowThresholdCount: number;
	fusionActive?: boolean;
}

/**
 * Recall scoring weight coefficients. Sum is 1.13 (scores are an unnormalised
 * weighted sum; may exceed 1.0). minScore thresholds in DEFAULT_MEMORY_CONFIG
 * are calibrated against these weights.
 *
 * Pinned by tests/unit/memory/scoring.test.ts to detect drift.
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
): RecallResultItem | null {
	const result = scoreMemoryRecordDetailed(
		record,
		request,
		createScoringContext(request),
	);
	return result.item;
}

function scoreMemoryRecordDetailed(
	record: MemoryRecord,
	request: RecallRequest,
	context: RecallScoringContext,
): { item: RecallResultItem | null; skipReason?: 'filtered' | 'no_signal' } {
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

	const score =
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
	].filter(Boolean);

	return {
		item: {
			record,
			score,
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
): RecallResultItem[] {
	return scoreMemoryRecordsWithDiagnostics(records, request).items;
}

export function scoreMemoryRecordsWithDiagnostics(
	records: MemoryRecord[],
	request: RecallRequest,
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
	};
	const items: RecallResultItem[] = [];

	for (const record of records) {
		const result = scoreMemoryRecordDetailed(record, request, context);
		if (!result.item) {
			if (result.skipReason === 'filtered')
				diagnostics.preScoredFilteredCount++;
			if (result.skipReason === 'no_signal') diagnostics.noSignalCount++;
			continue;
		}
		diagnostics.scoredCount++;
		if (result.item.score < minScore) {
			diagnostics.belowThresholdCount++;
			continue;
		}
		items.push(result.item);
	}

	items.sort(
		(a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
	);
	diagnostics.returnedCount = items.length;
	return { items, diagnostics };
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
