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
	scoredCount: number;
	returnedCount: number;
	noSignalCount: number;
	belowThresholdCount: number;
}

function tokenize(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\w\s-]/g, ' ')
			.split(/\s+/)
			.map((token) => token.trim())
			.filter(Boolean),
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
	const result = scoreMemoryRecordDetailed(record, request);
	return result.item;
}

function scoreMemoryRecordDetailed(
	record: MemoryRecord,
	request: RecallRequest,
): { item: RecallResultItem | null; skipReason?: 'no_signal' } {
	if (!request.includeExpired && isExpired(record)) return { item: null };
	if (record.supersededBy) return { item: null };
	if (record.metadata.deleted === true) return { item: null };
	if (!scopeAllowed(record.scope, request.scopes)) return { item: null };
	if (request.kinds && !request.kinds.includes(record.kind)) {
		return { item: null };
	}

	const queryTokens =
		request.mode === 'injection' && request.task
			? tokenize(request.task)
			: tokenize(request.query);
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
	const kindQueryOverlap = overlap(
		queryTokens,
		tokenize(normalizeKindText(record.kind)),
	);
	const textOverlap = overlap(queryTokens, textTokens);
	const tagOverlap = overlap(queryTokens, tagTokens);
	const fileOverlap = overlap(queryTokens, fileTokens);
	const symbolOverlap = overlap(queryTokens, symbolTokens);
	const kindMatch = request.kinds?.includes(record.kind) ?? false;
	const scopeMatch = scopeAllowed(record.scope, request.scopes);
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
		textOverlap * 0.45 +
		tagOverlap * 0.2 +
		fileOverlap * 0.05 +
		symbolOverlap * 0.05 +
		scopeSpecificityBoost(record.scope) * 0.15 +
		kindProfileBoost(record.kind, request) * 0.1 +
		record.confidence * 0.1;

	const reasonParts = [
		textOverlap > 0 ? `text_overlap=${textOverlap.toFixed(2)}` : null,
		tagOverlap > 0 ? `tag_overlap=${tagOverlap.toFixed(2)}` : null,
		fileOverlap > 0 ? `file_overlap=${fileOverlap.toFixed(2)}` : null,
		symbolOverlap > 0 ? `symbol_overlap=${symbolOverlap.toFixed(2)}` : null,
		kindQueryOverlap > 0 ? `kind_query=${kindQueryOverlap.toFixed(2)}` : null,
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
	const diagnostics: RecallScoringDiagnostics = {
		candidateCount: records.length,
		scoredCount: 0,
		returnedCount: 0,
		noSignalCount: 0,
		belowThresholdCount: 0,
	};
	const items: RecallResultItem[] = [];

	for (const record of records) {
		const result = scoreMemoryRecordDetailed(record, request);
		if (!result.item) {
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
