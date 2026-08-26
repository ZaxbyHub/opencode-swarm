import { createHash } from 'node:crypto';
import path from 'node:path';

import {
	containsControlChars,
	containsPathTraversal,
} from '../../utils/path-security';
import {
	SYMBOL_EDGE_KIND_VALUES,
	SYMBOL_EDGE_RESOLUTION_VALUES,
	type SymbolEdge,
	type SymbolEdgeEvidence,
	type SymbolEdgeKind,
	type SymbolEdgeResolution,
	type SymbolIdentityKind,
} from './types';

export const LOW_CONFIDENCE_SYMBOL_EDGE_THRESHOLD = 0.5;
export const MAX_SYMBOL_EDGE_EVIDENCE = 16;

const MAX_EVIDENCE_PATH_LENGTH = 1024;
const MAX_EXTRACTOR_LENGTH = 128;
const MAX_SYMBOL_NAME_LENGTH = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KIND_SET = new Set<string>(SYMBOL_EDGE_KIND_VALUES);
const RESOLUTION_SET = new Set<string>(SYMBOL_EDGE_RESOLUTION_VALUES);
const V2_KEYS = [
	'id',
	'fromId',
	'toId',
	'kind',
	'confidence',
	'resolution',
	'evidence',
] as const;

function canonicalText(value: string): string {
	return value.normalize('NFC');
}

function canonicalPath(value: string): string {
	const normalized = canonicalText(value)
		.replace(/\\/g, '/')
		.replace(/\/{2,}/g, '/')
		.replace(/^(?:\.\/)+/, '')
		.replace(/\/$/, '');
	return normalized.replace(
		/^([A-Z]):\//,
		(_, drive: string) => `${drive.toLowerCase()}:/`,
	);
}

function digest(parts: readonly string[]): string {
	return createHash('sha256')
		.update(parts.join('\u0000'), 'utf8')
		.digest('hex');
}

export function deriveRepoRootId(workspaceRoot: string): string {
	const canonical = canonicalPath(workspaceRoot);
	const segments = canonical.split('/').filter(Boolean);
	const label = canonicalText(segments.at(-1) ?? 'repository');
	return label || 'repository';
}

export function relativeSymbolPath(
	workspaceRoot: string,
	filePath: string,
): string {
	const root = canonicalPath(path.resolve(workspaceRoot));
	const file = canonicalPath(path.resolve(filePath));
	const prefix = `${root}/`;
	return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

export function createStableSymbolId(
	repoRootId: string,
	relativePath: string,
	qualifiedName: string,
	identityKind: SymbolIdentityKind,
): string {
	return digest([
		canonicalText(repoRootId),
		canonicalPath(relativePath),
		canonicalText(qualifiedName),
		identityKind,
	]);
}

export function createStableSymbolEdgeId(
	fromId: string,
	toId: string,
	kind: SymbolEdgeKind,
): string {
	return digest([fromId, toId, kind]);
}

export function hashSymbolEdgeSnippet(snippet: string): string {
	return digest([canonicalText(snippet.replace(/\r$/, ''))]);
}

export function isCompleteSymbolEdge(edge: SymbolEdge): boolean {
	return V2_KEYS.every((key) => edge[key] !== undefined);
}

function hasAnyV2Field(edge: SymbolEdge): boolean {
	return V2_KEYS.some((key) => edge[key] !== undefined);
}

function identityKind(symbol: string): SymbolIdentityKind {
	return symbol === '<module>' ? 'module' : 'symbol';
}

function computedIds(
	edge: Pick<SymbolEdge, 'fromFile' | 'fromSymbol' | 'toFile' | 'toSymbol'>,
	workspaceRoot: string,
	repoRootId: string,
	kind: SymbolEdgeKind,
): { fromId: string; toId: string; id: string } {
	const fromId = createStableSymbolId(
		repoRootId,
		relativeSymbolPath(workspaceRoot, edge.fromFile),
		edge.fromSymbol,
		identityKind(edge.fromSymbol),
	);
	const toId = createStableSymbolId(
		repoRootId,
		relativeSymbolPath(workspaceRoot, edge.toFile),
		edge.toSymbol,
		identityKind(edge.toSymbol),
	);
	return { fromId, toId, id: createStableSymbolEdgeId(fromId, toId, kind) };
}

function validateCoordinate(
	name: string,
	value: unknown,
): asserts value is string {
	const maxLength = name.endsWith('File') ? 4096 : MAX_SYMBOL_NAME_LENGTH;
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxLength ||
		containsControlChars(value)
	) {
		throw new Error(`invalid ${name}`);
	}
}

function validateEvidence(
	evidence: unknown,
): asserts evidence is SymbolEdgeEvidence[] {
	if (!Array.isArray(evidence) || evidence.length > MAX_SYMBOL_EDGE_EVIDENCE) {
		throw new Error('invalid evidence');
	}
	for (const item of evidence) {
		if (typeof item !== 'object' || item === null) {
			throw new Error('invalid evidence entry');
		}
		const entry = item as Partial<SymbolEdgeEvidence>;
		if (
			typeof entry.file !== 'string' ||
			entry.file.length === 0 ||
			entry.file.length > MAX_EVIDENCE_PATH_LENGTH ||
			entry.file.startsWith('/') ||
			/^[A-Za-z]:[/\\]/.test(entry.file) ||
			containsControlChars(entry.file) ||
			containsPathTraversal(entry.file) ||
			!Number.isInteger(entry.line) ||
			(entry.line ?? 0) < 1 ||
			(entry.column !== undefined &&
				(!Number.isInteger(entry.column) || entry.column < 1)) ||
			typeof entry.snippetHash !== 'string' ||
			!SHA256_PATTERN.test(entry.snippetHash) ||
			typeof entry.extractor !== 'string' ||
			entry.extractor.length === 0 ||
			entry.extractor.length > MAX_EXTRACTOR_LENGTH ||
			containsControlChars(entry.extractor)
		) {
			throw new Error('invalid evidence entry');
		}
	}
}

function evidenceKey(entry: SymbolEdgeEvidence): string {
	return [
		canonicalPath(entry.file),
		entry.line,
		entry.column ?? 0,
		entry.snippetHash,
		canonicalText(entry.extractor),
	].join('\u0000');
}

export function mergeSymbolEdgeEvidence(
	left: readonly SymbolEdgeEvidence[],
	right: readonly SymbolEdgeEvidence[],
): SymbolEdgeEvidence[] {
	const byKey = new Map<string, SymbolEdgeEvidence>();
	for (const entry of [...left, ...right]) {
		byKey.set(evidenceKey(entry), entry);
	}
	return [...byKey.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.slice(0, MAX_SYMBOL_EDGE_EVIDENCE)
		.map(([, entry]) => entry);
}

export function normalizeSymbolEdge(
	edge: SymbolEdge,
	workspaceRoot: string,
	repoRootId: string,
): SymbolEdge & Required<Pick<SymbolEdge, (typeof V2_KEYS)[number]>> {
	validateCoordinate('fromFile', edge.fromFile);
	validateCoordinate('fromSymbol', edge.fromSymbol);
	validateCoordinate('toFile', edge.toFile);
	validateCoordinate('toSymbol', edge.toSymbol);
	if (
		containsPathTraversal(edge.fromFile) ||
		containsPathTraversal(edge.toFile)
	) {
		throw new Error('invalid symbol edge path');
	}

	const anyV2 = hasAnyV2Field(edge);
	if (anyV2 && !isCompleteSymbolEdge(edge)) {
		throw new Error('partial SymbolEdge v2 fields');
	}
	const kind = (edge.kind ?? 'REFERENCES') as SymbolEdgeKind;
	const resolution = (edge.resolution ?? 'unresolved') as SymbolEdgeResolution;
	const confidence = edge.confidence ?? 0;
	const evidence = edge.evidence ?? [];
	if (!KIND_SET.has(kind)) throw new Error('invalid symbol edge kind');
	if (!RESOLUTION_SET.has(resolution)) {
		throw new Error('invalid symbol edge resolution');
	}
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
		throw new Error('invalid symbol edge confidence');
	}
	validateEvidence(evidence);

	const ids = computedIds(edge, workspaceRoot, repoRootId, kind);
	if (
		anyV2 &&
		(edge.fromId !== ids.fromId || edge.toId !== ids.toId || edge.id !== ids.id)
	) {
		throw new Error('symbol edge stable ID mismatch');
	}
	return {
		...edge,
		...ids,
		kind,
		confidence,
		resolution,
		evidence: mergeSymbolEdgeEvidence([], evidence),
	};
}

export function createSymbolEdgeV2(
	edge: Pick<SymbolEdge, 'fromFile' | 'fromSymbol' | 'toFile' | 'toSymbol'>,
	workspaceRoot: string,
	repoRootId: string,
	options: {
		kind?: SymbolEdgeKind;
		confidence: number;
		resolution: SymbolEdgeResolution;
		evidence: SymbolEdgeEvidence[];
	},
): SymbolEdge {
	const kind = options.kind ?? 'REFERENCES';
	const ids = computedIds(edge, workspaceRoot, repoRootId, kind);
	return normalizeSymbolEdge(
		{ ...edge, ...ids, kind, ...options },
		workspaceRoot,
		repoRootId,
	);
}

export function mergeSymbolEdges(
	left: SymbolEdge,
	right: SymbolEdge,
	workspaceRoot: string,
	repoRootId: string,
): SymbolEdge {
	const a = normalizeSymbolEdge(left, workspaceRoot, repoRootId);
	const b = normalizeSymbolEdge(right, workspaceRoot, repoRootId);
	if (a.id !== b.id) throw new Error('cannot merge different symbol edges');
	const resolutionRank = (value: SymbolEdgeResolution) =>
		SYMBOL_EDGE_RESOLUTION_VALUES.indexOf(value);
	const preferred =
		a.confidence > b.confidence ||
		(a.confidence === b.confidence &&
			resolutionRank(a.resolution) <= resolutionRank(b.resolution))
			? a
			: b;
	return {
		...a,
		confidence: Math.max(a.confidence, b.confidence),
		resolution: preferred.resolution,
		evidence: mergeSymbolEdgeEvidence(a.evidence, b.evidence),
	};
}
