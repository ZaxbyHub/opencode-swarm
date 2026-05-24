import { isExpired, stableScopeKey } from './schema';
import type {
	MemoryKind,
	MemoryRecord,
	MemoryScopeRef,
	RecallRequest,
	RecallResultItem,
} from './types';

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
	if (!request.includeExpired && isExpired(record)) return null;
	if (record.supersededBy) return null;
	if (record.metadata.deleted === true) return null;
	if (!scopeAllowed(record.scope, request.scopes)) return null;
	if (request.kinds && !request.kinds.includes(record.kind)) return null;

	const queryTokens = tokenize(request.query);
	const textTokens = tokenize(record.text);
	const tagTokens = tokenize(record.tags.join(' '));
	const textOverlap = overlap(queryTokens, textTokens);
	const tagOverlap = overlap(queryTokens, tagTokens);
	const score =
		textOverlap * 0.45 +
		tagOverlap * 0.2 +
		scopeSpecificityBoost(record.scope) * 0.15 +
		kindProfileBoost(record.kind, request) * 0.1 +
		record.confidence * 0.1;

	const reasonParts = [
		textOverlap > 0 ? `text_overlap=${textOverlap.toFixed(2)}` : null,
		tagOverlap > 0 ? `tag_overlap=${tagOverlap.toFixed(2)}` : null,
		`scope=${record.scope.type}`,
		`confidence=${record.confidence.toFixed(2)}`,
	].filter(Boolean);

	return {
		record,
		score,
		reason: reasonParts.join(', '),
	};
}

export function scoreMemoryRecords(
	records: MemoryRecord[],
	request: RecallRequest,
): RecallResultItem[] {
	return records
		.map((record) => scoreMemoryRecord(record, request))
		.filter((item): item is RecallResultItem => item !== null)
		.filter((item) => item.score >= (request.minScore ?? 0))
		.sort(
			(a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id),
		);
}
