/**
 * KG-14 expanded graph query functions (issue #1535).
 *
 * Symbol-level, impact, diff, and explainability queries over the persisted
 * repo graph. Every function is stateless and read-only: inputs are validated
 * by the `repo_map` tool layer (`src/tools/repo-map.ts`); this module assumes
 * well-formed arguments and focuses on bounded, workspace-relative,
 * provenance-bearing output.
 *
 * Bounding contract: every list-shaped output is capped (default caps below
 * or the caller's `topN`), every result carries a `budget {returned, dropped}`
 * envelope, and paths in results are workspace-relative with forward slashes.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	containsPathTraversal,
	isCanonicalPathWithinRoot,
} from '../../utils/path-security';
import {
	extractSignatureText,
	getBlastRadius,
	getDependencies,
	getGraphNode,
	getImporters,
} from './query';
import {
	createStableSymbolId,
	deriveRepoRootId,
	LOW_CONFIDENCE_SYMBOL_EDGE_THRESHOLD,
} from './symbol-edge';
import type {
	BlastRadiusResult,
	ConeEntry,
	DataOperationFact,
	DiffContextResult,
	DiffFileSummary,
	DiffSymbolChange,
	ExplainReason,
	GraphExplainResult,
	GraphNode,
	GraphSymbolKind,
	GraphSymbolVisibility,
	ImpactConeResult,
	RepoGraph,
	RouteFact,
	SecurityFact,
	SymbolContextResult,
	SymbolEdge,
	SymbolHit,
	SymbolSearchResult,
} from './types';
import {
	DEFAULT_MAX_SOURCE_BYTES,
	inferPackageBoundary,
	isSchemaVersionAtLeast,
	normalizeGraphPath,
} from './types';

const SEARCH_DEFAULT_TOP_N = 25;
const CONTEXT_DEFAULT_TOP_N = 25;
const CONE_DEFAULT_TOP_N = 50;
/**
 * Hard cap on cone TRAVERSAL (OW-8): a densely connected hub symbol can reach
 * far more relationships than topN returns, and without this every BFS
 * structure (queue, dedupe set, visited set, cone-file set, entries) would
 * scale with local graph density. Once the dedupe set reaches the cap the
 * BFS stops discovering — no further enqueues, emissions, or file collection —
 * so all traversal state is O(cap). Discoveries past the cap count as dropped
 * and a distinct warning discloses that the cone beyond the cap was not
 * visited (the result is a bounded prefix, not a silently incomplete cone).
 */
const CONE_ENTRIES_HARD_CAP = 5000;
const CONE_ONTOLOGY_CAP = 20;
const CONE_HUB_NOTE_CAP = 5;
const CONE_HUB_IMPORTER_THRESHOLD = 10;
const EXPLAIN_DEFAULT_TOP_N = 20;
const EXPLAIN_EVIDENCE_CAP = 3;
const DIFF_MAX_FILES = 50;
const DIFF_MAX_HUNKS = 200;
const DIFF_DEFAULT_TOP_N = 25;
const DIFF_CHANGED_LINES_CAP = 50;
const SYMBOL_ID_SCAN_CAP = 10_000;
const MAX_SOURCE_LINES = 80;
const MATCH_TIERS = ['exact', 'prefix', 'substring', 'subsequence'] as const;

// ============ Shared helpers ============

function graphRoot(graph: RepoGraph): string {
	return path.resolve(graph.workspaceRoot);
}

/**
 * Workspace-relative, forward-slash display path for a graph file path.
 *
 * Inherited caveat (same as `getContextPack`'s `displayPath` in query.ts): on
 * Windows, `path.relative` compares drive letters case-sensitively, so a
 * graph whose stored paths disagree with the workspace root's drive-letter
 * casing falls back to the normalized absolute path rather than a wrong
 * `../..` escape. Builder-produced graphs share one root casing, so this is
 * defensive only.
 */
function rel(graph: RepoGraph, file: string): string {
	const normalized = normalizeGraphPath(file);
	if (!path.isAbsolute(normalized)) return normalized.replace(/\\/g, '/');
	try {
		const relPath = path.relative(graphRoot(graph), normalized);
		if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
			return normalized.replace(/\\/g, '/');
		}
		return relPath.replace(/\\/g, '/');
	} catch {
		return normalized.replace(/\\/g, '/');
	}
}

/** Own-property lookup that never resolves through Object.prototype. */
function ownEntry<T>(
	map: Record<string, T> | undefined,
	key: string,
): T | undefined {
	if (map === undefined) return undefined;
	return Object.hasOwn(map, key) ? map[key] : undefined;
}

function symbolKindOf(
	node: GraphNode | undefined,
	symbol: string,
): GraphSymbolKind | null {
	return ownEntry(node?.exportKinds, symbol) ?? null;
}

function visibilityOf(node: GraphNode, symbol: string): GraphSymbolVisibility {
	return node.exports.includes(symbol) ? 'exported' : 'module-local';
}

/**
 * Forward/reverse symbol-edge maps keyed `normalizedAbsoluteFile\0symbol` —
 * the same keying as `getContextPack`, so traversal semantics stay identical.
 */
function symbolEdgeMaps(graph: RepoGraph): {
	forward: Map<string, SymbolEdge[]>;
	reverse: Map<string, SymbolEdge[]>;
} {
	const forward = new Map<string, SymbolEdge[]>();
	const reverse = new Map<string, SymbolEdge[]>();
	for (const edge of graph.symbolEdges ?? []) {
		const fromKey = `${normalizeGraphPath(edge.fromFile)}\0${edge.fromSymbol}`;
		const toKey = `${normalizeGraphPath(edge.toFile)}\0${edge.toSymbol}`;
		const fromEdges = forward.get(fromKey);
		if (fromEdges) fromEdges.push(edge);
		else forward.set(fromKey, [edge]);
		const toEdges = reverse.get(toKey);
		if (toEdges) toEdges.push(edge);
		else reverse.set(toKey, [edge]);
	}
	return { forward, reverse };
}

function symbolKey(node: GraphNode, symbol: string): string {
	return `${normalizeGraphPath(node.filePath)}\0${symbol}`;
}

function coneEntryFromEdge(
	graph: RepoGraph,
	edge: SymbolEdge,
	direction: 'caller' | 'callee',
	depth: number,
): ConeEntry {
	return {
		file:
			direction === 'caller'
				? rel(graph, edge.fromFile)
				: rel(graph, edge.toFile),
		symbol: direction === 'caller' ? edge.fromSymbol : edge.toSymbol,
		direction,
		depth,
		relationshipKind: edge.kind ?? null,
		confidence: edge.confidence ?? null,
		resolution: edge.resolution ?? null,
	};
}

function sortConeEntries(entries: ConeEntry[]): ConeEntry[] {
	return entries.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		if (a.direction !== b.direction) {
			return a.direction.localeCompare(b.direction);
		}
		const fileCmp = a.file.localeCompare(b.file);
		if (fileCmp !== 0) return fileCmp;
		return a.symbol.localeCompare(b.symbol);
	});
}

/** Depth-1 callers/callees for a symbol, sorted and topN-capped. */
function directNeighbors(
	graph: RepoGraph,
	node: GraphNode,
	symbol: string,
	topN: number,
	warnings: string[],
): { callers: ConeEntry[]; callees: ConeEntry[]; dropped: number } {
	const { forward, reverse } = symbolEdgeMaps(graph);
	const key = symbolKey(node, symbol);
	const byFileSymbol = (a: ConeEntry, b: ConeEntry) =>
		a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol);
	const callees = (forward.get(key) ?? [])
		.map((edge) => coneEntryFromEdge(graph, edge, 'callee', 1))
		.sort(byFileSymbol);
	const callers = (reverse.get(key) ?? [])
		.map((edge) => coneEntryFromEdge(graph, edge, 'caller', 1))
		.sort(byFileSymbol);
	const dropped =
		Math.max(0, callees.length - topN) + Math.max(0, callers.length - topN);
	if (dropped > 0) {
		warnings.push(`${dropped} direct neighbor(s) omitted by top_n=${topN}`);
	}
	return {
		callers: callers.slice(0, topN),
		callees: callees.slice(0, topN),
		dropped,
	};
}

/** Case-insensitive subsequence test (the loosest search tier). */
function isSubsequence(query: string, candidate: string): boolean {
	let qi = 0;
	for (let ci = 0; qi < query.length && ci < candidate.length; ci++) {
		if (candidate[ci] === query[qi]) qi++;
	}
	return qi === query.length;
}

function matchTier(
	query: string,
	symbol: string,
): (typeof MATCH_TIERS)[number] | null {
	const q = query.toLowerCase();
	const s = symbol.toLowerCase();
	if (s === q) return 'exact';
	if (s.startsWith(q)) return 'prefix';
	if (s.includes(q)) return 'substring';
	if (isSubsequence(q, s)) return 'subsequence';
	return null;
}

// ============ symbol_search ============

export function searchSymbols(
	graph: RepoGraph,
	options: {
		query: string;
		kind?: GraphSymbolKind;
		language?: string;
		file?: string;
		visibility?: GraphSymbolVisibility;
		topN?: number;
	},
): SymbolSearchResult {
	const topN = options.topN ?? SEARCH_DEFAULT_TOP_N;
	const warnings: string[] = [];
	const kindSupported = isSchemaVersionAtLeast(graph.schema_version, '1.6.0');
	if (options.kind !== undefined && !kindSupported) {
		// Schema gate (context_pack precedent): answering a kind-filtered query
		// with UNFILTERED hits would be misleading, so the result degrades to
		// an explicit empty + warning instead.
		return {
			query: options.query,
			hits: [],
			count: 0,
			budget: { returned: 0, dropped: 0 },
			kindSupported: false,
			warnings: [
				'kind filter requires graph schema 1.6.0+; rebuild with repo_map action="build"',
			],
		};
	}
	const kindFilter = options.kind;

	if (!options.query || options.query.trim().length === 0) {
		return {
			query: options.query,
			hits: [],
			count: 0,
			budget: { returned: 0, dropped: 0 },
			kindSupported,
			warnings: [...warnings, 'query is empty'],
		};
	}

	let fileFilterKey: string | null = null;
	if (options.file !== undefined) {
		const node = getGraphNode(graph, options.file);
		if (!node) {
			return {
				query: options.query,
				hits: [],
				count: 0,
				budget: { returned: 0, dropped: 0 },
				kindSupported,
				warnings: [
					...warnings,
					`file filter not found in graph: ${options.file.replace(/\\/g, '/')}`,
				],
			};
		}
		fileFilterKey = normalizeGraphPath(node.filePath);
	}

	const hits: SymbolHit[] = [];
	for (const node of Object.values(graph.nodes)) {
		if (
			fileFilterKey !== null &&
			normalizeGraphPath(node.filePath) !== fileFilterKey
		) {
			continue;
		}
		if (options.language !== undefined && node.language !== options.language) {
			continue;
		}
		const exportedSet = new Set(node.exports);
		const addHit = (symbol: string, exported: boolean): void => {
			const visibility: GraphSymbolVisibility = exported
				? 'exported'
				: 'module-local';
			if (
				options.visibility !== undefined &&
				options.visibility !== visibility
			) {
				return;
			}
			const kind = symbolKindOf(node, symbol);
			if (kindFilter !== undefined && kind !== kindFilter) return;
			const tier = matchTier(options.query, symbol);
			if (tier === null) return;
			const range = ownEntry(node.exportRanges, symbol);
			const line = ownEntry(node.exportLines, symbol) ?? range?.startLine ?? 0;
			hits.push({
				file: rel(graph, node.filePath),
				symbol,
				kind,
				visibility,
				language: node.language,
				line,
				exported,
				match: tier,
			});
		};
		for (const symbol of node.exports) addHit(symbol, true);
		if (node.exportRanges !== undefined) {
			for (const symbol of Object.keys(node.exportRanges)) {
				if (!exportedSet.has(symbol)) addHit(symbol, false);
			}
		}
	}

	hits.sort((a, b) => {
		const tierCmp = MATCH_TIERS.indexOf(a.match) - MATCH_TIERS.indexOf(b.match);
		if (tierCmp !== 0) return tierCmp;
		const fileCmp = a.file.localeCompare(b.file);
		if (fileCmp !== 0) return fileCmp;
		return a.symbol.localeCompare(b.symbol);
	});

	const returned = hits.slice(0, topN);
	const dropped = hits.length - returned.length;
	if (dropped > 0) {
		warnings.push(`${dropped} hit(s) omitted by top_n=${topN}`);
	}
	return {
		query: options.query,
		hits: returned,
		count: returned.length,
		budget: { returned: returned.length, dropped },
		kindSupported,
		warnings,
	};
}

// ============ symbol_context ============

function resolveSymbolById(
	graph: RepoGraph,
	symbolId: string,
): {
	node: GraphNode | null;
	symbol: string | null;
	computed: number;
	capped: boolean;
} {
	const repoRootId = graph.repoRootId ?? deriveRepoRootId(graph.workspaceRoot);
	const root = graphRoot(graph);
	let computed = 0;
	for (const node of Object.values(graph.nodes)) {
		const relativePath = path.relative(root, normalizeGraphPath(node.filePath));
		const names = new Set<string>(node.exports);
		if (node.exportRanges !== undefined) {
			for (const name of Object.keys(node.exportRanges)) names.add(name);
		}
		for (const symbol of names) {
			if (computed >= SYMBOL_ID_SCAN_CAP) {
				return { node: null, symbol: null, computed, capped: true };
			}
			computed++;
			const identityKind = symbol === '<module>' ? 'module' : 'symbol';
			const id = createStableSymbolId(
				repoRootId,
				relativePath,
				symbol,
				identityKind,
			);
			if (id === symbolId) {
				return { node, symbol, computed, capped: false };
			}
		}
	}
	return { node: null, symbol: null, computed, capped: false };
}

function stableIdFor(
	graph: RepoGraph,
	node: GraphNode,
	symbol: string,
): string | null {
	const repoRootId = graph.repoRootId ?? deriveRepoRootId(graph.workspaceRoot);
	const root = graphRoot(graph);
	const relativePath = path.relative(root, normalizeGraphPath(node.filePath));
	if (relativePath.startsWith('..')) return null;
	const identityKind = symbol === '<module>' ? 'module' : 'symbol';
	return createStableSymbolId(repoRootId, relativePath, symbol, identityKind);
}

/**
 * Containment-checked, size-capped source read shared by symbol_context.
 * Mirrors the getContextPack read path: canonical containment, 1 MiB stat
 * cap, ≤80-line slice. Fail-open — `text` is null with a `reason`.
 */
function readDefinitionSource(
	graph: RepoGraph,
	node: GraphNode,
	startLine: number,
	endLine: number,
):
	| { text: string; mode: 'full' | 'summary' }
	| { text: null; mode: null; reason: string } {
	const root = graphRoot(graph);
	const resolved = path.resolve(normalizeGraphPath(node.filePath));
	if (!isCanonicalPathWithinRoot(resolved, root)) {
		return { text: null, mode: null, reason: 'source outside workspace' };
	}
	try {
		const stats = fs.statSync(resolved);
		if (stats.size > DEFAULT_MAX_SOURCE_BYTES) {
			return { text: null, mode: null, reason: 'source too large' };
		}
		const content = fs.readFileSync(resolved, 'utf-8');
		const lines = content.split('\n');
		const start = Math.max(0, startLine - 1);
		const end = Math.min(lines.length, start + MAX_SOURCE_LINES, endLine);
		const slice = lines.slice(start, end);
		const capped =
			endLine - startLine + 1 > MAX_SOURCE_LINES &&
			end === start + MAX_SOURCE_LINES;
		return { text: slice.join('\n'), mode: capped ? 'summary' : 'full' };
	} catch {
		return { text: null, mode: null, reason: 'source read failed' };
	}
}

export function getSymbolContext(
	graph: RepoGraph,
	options: {
		file?: string;
		symbol?: string;
		symbolId?: string;
		includeSource?: boolean;
		topN?: number;
	},
): SymbolContextResult {
	const topN = options.topN ?? CONTEXT_DEFAULT_TOP_N;
	const warnings: string[] = [];
	const emptyBudget = {
		callersReturned: 0,
		calleesReturned: 0,
		dropped: 0,
	};
	const empty: SymbolContextResult = {
		found: false,
		identity: null,
		callers: [],
		callees: [],
		budget: emptyBudget,
		warnings,
	};

	let node: GraphNode | null = null;
	let symbol: string | null = null;
	let idScan: SymbolContextResult['symbolIdScan'];
	if (options.symbolId !== undefined) {
		const scan = resolveSymbolById(graph, options.symbolId);
		idScan = { computed: scan.computed, capped: scan.capped };
		if (scan.capped) {
			warnings.push(
				`symbol_id scan cap (${SYMBOL_ID_SCAN_CAP}) reached without a match; the symbol may exist beyond the cap — retry with file+symbol`,
			);
		}
		node = scan.node;
		symbol = scan.symbol;
		if (node === null || symbol === null) {
			return {
				...empty,
				symbolIdScan: idScan,
				note: 'No symbol matches the given symbol_id in this graph.',
			};
		}
	} else if (options.file !== undefined && options.symbol !== undefined) {
		node = getGraphNode(graph, options.file) ?? null;
		symbol = options.symbol;
		if (node === null) {
			return { ...empty, note: 'Target file not found in graph' };
		}
	} else {
		return {
			...empty,
			note: 'symbol_context requires symbol_id or file+symbol',
		};
	}

	const range = ownEntry(node.exportRanges, symbol);
	const line = ownEntry(node.exportLines, symbol) ?? range?.startLine ?? 0;
	const identity: NonNullable<SymbolContextResult['identity']> = {
		file: rel(graph, node.filePath),
		symbol,
		symbolId: stableIdFor(graph, node, symbol),
		kind: symbolKindOf(node, symbol),
		visibility: visibilityOf(node, symbol),
		language: node.language,
		startLine: line,
		endLine: range?.endLine ?? null,
	};

	if (line === 0 && range === undefined && !node.exports.includes(symbol)) {
		return {
			...empty,
			identity,
			note: 'Symbol not defined in this file (no export or exportRange entry).',
		};
	}

	// Signature (and optional source text) share one containment-checked read.
	let signature: string | undefined;
	let source: SymbolContextResult['source'];
	if (line > 0 && range !== undefined) {
		const read = readDefinitionSource(graph, node, line, range.endLine);
		if (read.text !== null) {
			// extractSignatureText's contract is absolute-into-FULL-file lines
			// (its context_pack caller passes whole-file lines). `read.text` is
			// a slice that already STARTS at the definition line, so the
			// signature scan begins at slice index 0 (PRR-001: passing the
			// absolute `line` here read line 2·line−1 or ran out of slice).
			signature = extractSignatureText(read.text.split('\n'), 1) || undefined;
			if (options.includeSource === true) {
				source = {
					text: read.text,
					mode: read.mode,
					hash: createHash('sha256').update(read.text).digest('hex'),
					startLine: line,
					endLine: range.endLine,
				};
			}
		} else {
			warnings.push(`definition source unavailable: ${read.reason}`);
		}
	} else if (options.includeSource === true) {
		warnings.push(
			'source unavailable: symbol has no persisted export range (internal or legacy symbol)',
		);
	}

	const neighbors = directNeighbors(graph, node, symbol, topN, warnings);
	return {
		found: true,
		identity,
		...(idScan !== undefined ? { symbolIdScan: idScan } : {}),
		...(signature !== undefined ? { signature } : {}),
		...(source !== undefined ? { source } : {}),
		callers: neighbors.callers,
		callees: neighbors.callees,
		budget: {
			callersReturned: neighbors.callers.length,
			calleesReturned: neighbors.callees.length,
			dropped: neighbors.dropped,
		},
		warnings,
	};
}

// ============ impact_cone ============

export function getImpactCone(
	graph: RepoGraph,
	options: {
		file: string;
		symbol?: string;
		maxDepth?: number;
		topN?: number;
	},
): ImpactConeResult {
	const maxDepth = options.maxDepth ?? 3;
	const topN = options.topN ?? CONE_DEFAULT_TOP_N;
	const warnings: string[] = [];
	const node = getGraphNode(graph, options.file);
	const targetRel = node ? rel(graph, node.filePath) : options.file;
	const fileImpact: BlastRadiusResult = getBlastRadius(
		graph,
		[options.file],
		maxDepth,
	);
	if (!node) {
		warnings.push(`target file not found in graph: ${targetRel}`);
	}

	const entries: ConeEntry[] = [];
	const coneFileKeys = new Set<string>();
	if (node) coneFileKeys.add(normalizeGraphPath(node.filePath));
	// OW-8: the intermediate entries array is hard-capped so a densely
	// connected hub symbol cannot grow transient memory with graph density.
	// Traversal itself is bounded by the cap (OW-8): once the dedupe set
	// reaches it, no further symbols are enqueued, emitted, or collected, so
	// `queue`/`emitted`/`visited`/`coneFileKeys`/`entries` all stay O(cap) —
	// peak memory no longer scales with local graph density. Discoveries past
	// the cap count as dropped and the warning says the traversal was capped.
	let overflowDropped = 0;
	let traversalCapped = false;

	if (node && options.symbol !== undefined) {
		// Symbol-level cone as TWO direction-scoped BFS runs over symbolEdges:
		// the caller side follows reverse edges only (callers of callers), the
		// callee side forward edges only. An undirected BFS would bounce back
		// along the discovering edge and re-emit the target's own edge from the
		// neighbor's perspective, double-counting every relationship.
		const { forward, reverse } = symbolEdgeMaps(graph);
		const emitted = new Set<string>();
		const startKey = symbolKey(node, options.symbol);
		const runBfs = (direction: 'caller' | 'callee'): void => {
			const visited = new Set<string>([startKey]);
			const queue: { key: string; depth: number }[] = [
				{ key: startKey, depth: 0 },
			];
			let head = 0;
			while (head < queue.length) {
				const { key, depth } = queue[head]!;
				head++;
				if (depth >= maxDepth) continue;
				const edges =
					direction === 'caller'
						? (reverse.get(key) ?? [])
						: (forward.get(key) ?? []);
				for (const edge of edges) {
					const otherFile =
						direction === 'caller' ? edge.fromFile : edge.toFile;
					const otherSymbol =
						direction === 'caller' ? edge.fromSymbol : edge.toSymbol;
					const otherKey = `${normalizeGraphPath(otherFile)}\0${otherSymbol}`;
					const dedupeKey = `${direction}\0${otherKey}`;
					if (emitted.has(dedupeKey)) continue;
					if (emitted.size >= CONE_ENTRIES_HARD_CAP) {
						// Past the cap: count the relationship as dropped, but
						// emit nothing, collect nothing, and enqueue nothing —
						// every BFS structure stays bounded.
						overflowDropped++;
						traversalCapped = true;
						continue;
					}
					emitted.add(dedupeKey);
					entries.push(coneEntryFromEdge(graph, edge, direction, depth + 1));
					coneFileKeys.add(normalizeGraphPath(otherFile));
					if (!visited.has(otherKey)) {
						visited.add(otherKey);
						if (depth + 1 < maxDepth) {
							queue.push({ key: otherKey, depth: depth + 1 });
						}
					}
				}
			}
		};
		runBfs('caller');
		runBfs('callee');
	} else {
		// File-level cone: dependents from the blast radius.
		for (const dependent of [
			...fileImpact.directDependents,
			...fileImpact.transitiveDependents,
		]) {
			const dependentNode = getGraphNode(graph, dependent);
			if (dependentNode) {
				coneFileKeys.add(normalizeGraphPath(dependentNode.filePath));
			}
		}
	}

	sortConeEntries(entries);
	const returnedEntries = entries.slice(0, topN);
	const dropped = entries.length - returnedEntries.length + overflowDropped;
	const truncated = dropped > 0;
	if (truncated) {
		warnings.push(
			`${dropped} cone entr(ies) omitted${
				overflowDropped > 0
					? ` (${overflowDropped} beyond the ${CONE_ENTRIES_HARD_CAP}-entry traversal cap)`
					: ''
			} by top_n=${topN}`,
		);
	}
	if (traversalCapped) {
		warnings.push(
			`cone traversal stopped at ${CONE_ENTRIES_HARD_CAP} relationships; the cone beyond the cap was not visited — raise nothing, refine with a narrower file/symbol or smaller max_depth`,
		);
	}

	// Ontology aggregation over cone files; every list capped + de-duplicated.
	const tests: string[] = [];
	const routes: Array<{ file: string; fact: RouteFact }> = [];
	const dataFacts: Array<{ file: string; fact: DataOperationFact }> = [];
	const securityFacts: Array<{ file: string; fact: SecurityFact }> = [];
	const boundaryFiles = new Map<string, string[]>();
	for (const key of coneFileKeys) {
		const coneNode = graph.nodes[key];
		if (!coneNode) continue;
		const fileRel = rel(graph, coneNode.filePath);
		const ontology = coneNode.ontology;
		const boundary =
			ontology?.packageBoundary ?? inferPackageBoundary(coneNode.moduleName);
		const list = boundaryFiles.get(boundary) ?? [];
		list.push(fileRel);
		boundaryFiles.set(boundary, list);
		if (!ontology) continue;
		if (
			ontology.roles.includes('test_file') &&
			tests.length < CONE_ONTOLOGY_CAP
		) {
			tests.push(fileRel);
		}
		for (const fact of ontology.routes ?? []) {
			if (routes.length >= CONE_ONTOLOGY_CAP) break;
			routes.push({ file: fileRel, fact });
		}
		for (const fact of ontology.dataOperations ?? []) {
			if (dataFacts.length >= CONE_ONTOLOGY_CAP) break;
			dataFacts.push({ file: fileRel, fact });
		}
		for (const fact of ontology.security ?? []) {
			if (securityFacts.length >= CONE_ONTOLOGY_CAP) break;
			securityFacts.push({ file: fileRel, fact });
		}
	}
	const boundaries = [...boundaryFiles.entries()]
		.map(([name, files]) => ({
			name,
			files: files.slice(0, CONE_ONTOLOGY_CAP),
		}))
		.sort(
			(a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name),
		)
		.slice(0, CONE_ONTOLOGY_CAP);

	// Risk notes: fixed vocabulary with counts, emitted only when non-zero.
	const riskNotes: string[] = [];
	if (fileImpact.transitiveDependents.length > 0) {
		riskNotes.push(
			`transitive spread: ${fileImpact.transitiveDependents.length} file(s) beyond direct dependents`,
		);
	}
	const hubNotes: string[] = [];
	for (const key of coneFileKeys) {
		if (hubNotes.length >= CONE_HUB_NOTE_CAP) break;
		const coneNode = graph.nodes[key];
		if (!coneNode) continue;
		const importers = getImporters(graph, coneNode.moduleName).length;
		if (importers >= CONE_HUB_IMPORTER_THRESHOLD) {
			hubNotes.push(
				`hub file in cone: ${rel(graph, coneNode.filePath)} (importers: ${importers})`,
			);
		}
	}
	riskNotes.push(...hubNotes);
	const lowConfidence = entries.filter(
		(entry) =>
			entry.confidence !== null &&
			entry.confidence < LOW_CONFIDENCE_SYMBOL_EDGE_THRESHOLD,
	).length;
	if (lowConfidence > 0) {
		riskNotes.push(
			`low-confidence edges in cone: ${lowConfidence} — verify with graph_explain`,
		);
	}
	if (tests.length > 0) {
		riskNotes.push(`test files affected: ${tests.length}`);
	}
	if (boundaries.length > 1) {
		riskNotes.push(`package boundaries crossed: ${boundaries.length}`);
	}

	return {
		target: { file: targetRel, symbol: options.symbol ?? null },
		entries: returnedEntries,
		fileImpact,
		risk: fileImpact.riskLevel,
		riskNotes,
		tests: tests.sort((a, b) => a.localeCompare(b)),
		routes,
		dataFacts,
		securityFacts,
		boundaries,
		budget: { entriesReturned: returnedEntries.length, dropped },
		truncated,
		warnings,
	};
}

// ============ diff_context ============

interface ParsedDiffInterval {
	start: number;
	end: number;
}

interface ParsedDiffFile {
	file: string;
	intervals: ParsedDiffInterval[] | null;
	note?: string;
}

const DIFF_FILE_HEADER_RE = /^\+\+\+ (?:b\/)?(.+?)\r?$/;
const DIFF_OLD_HEADER_RE = /^--- (?:a\/)?(.+?)\r?$/;
const DIFF_HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Strict, bounded parse of a unified diff. Returns one entry per file with
 * the new-file hunk intervals (null when only file-level granularity is
 * known). `+++ b/<path>` headers drive file entries; a `--- a/<path>` header
 * that never reaches a `+++` (name-status listings, `+++ /dev/null` deletes)
 * falls back to a file-granularity entry so those files still map to
 * symbols. Duplicate sections for the same path merge into one entry.
 * Throws when nothing parseable exists (the tool layer converts the message
 * into an error envelope).
 */
function parseUnifiedDiff(diff: string): {
	files: ParsedDiffFile[];
	filesSeen: number;
	filesTruncated: boolean;
	hunksTruncated: boolean;
} {
	const byPath = new Map<string, ParsedDiffFile>();
	// `filesSeen` counts UNIQUE file paths that received (or were refused) an
	// entry — duplicate `+++` headers for an already-known path merge and do
	// not count again, so `filesDropped = filesSeen - files.length` can never
	// report phantom truncation.
	let filesSeen = 0;
	let filesTruncated = false;
	let hunksTruncated = false;
	let current: ParsedDiffFile | null = null;
	// `--- a/x` headers queue (not overwrite): a truncated patch series can
	// carry several old-side names before any `+++`, and losing all but the
	// last would silently drop files. Every queued name that never meets a
	// `+++` becomes a file-granularity entry at the next section boundary/EOF.
	const pendingOldPaths: string[] = [];
	let hunks = 0;
	// Hunk-state guard (PRR-004): while a hunk's body lines remain, NOTHING is
	// interpreted as a header — an added body line whose content starts with
	// `++ ` renders as `+++ x` in a real diff and must not hijack the parser
	// (mirror case: removed lines starting `-- ` → `--- x`). Body lines are
	// counted exactly: each consumes one old-side and/or new-side slot per
	// its first character; `\ No newline` markers consume neither.
	let oldRemaining = 0;
	let newRemaining = 0;
	// Returns the (new or merged) entry for a path, or null when the file cap
	// was hit. Callers assign `current` themselves so control-flow narrowing
	// sees every assignment.
	const entryFor = (target: string, note?: string): ParsedDiffFile | null => {
		if (byPath.has(target)) return byPath.get(target) ?? null;
		filesSeen++;
		if (byPath.size >= DIFF_MAX_FILES) {
			filesTruncated = true;
			return null;
		}
		const entry: ParsedDiffFile = {
			file: target,
			intervals: note !== undefined ? null : [],
			...(note !== undefined ? { note } : {}),
		};
		byPath.set(target, entry);
		return entry;
	};
	const flushPendingOldPaths = (): void => {
		for (const pending of pendingOldPaths.splice(0)) {
			if (pending === '/dev/null') continue;
			entryFor(pending, 'file-level granularity: no +++ header for this file');
		}
	};
	for (const rawLine of diff.split('\n')) {
		const line = rawLine.replace(/\r$/, '');
		if (oldRemaining > 0 || newRemaining > 0) {
			// Inside a hunk body: classify by first character and consume slots.
			if (!line.startsWith('\\')) {
				if (line.startsWith('-')) oldRemaining--;
				else if (line.startsWith('+')) newRemaining--;
				else {
					oldRemaining--;
					newRemaining--;
				}
			}
			continue;
		}
		const hunk = DIFF_HUNK_RE.exec(line);
		if (hunk !== null) {
			const oldCount = hunk[2] !== undefined ? Number.parseInt(hunk[2], 10) : 1;
			const newCount = hunk[4] !== undefined ? Number.parseInt(hunk[4], 10) : 1;
			oldRemaining = Math.max(0, oldCount);
			newRemaining = Math.max(0, newCount);
			if (current === null || current.intervals === null) continue;
			if (hunks >= DIFF_MAX_HUNKS) {
				hunksTruncated = true;
				continue;
			}
			hunks++;
			const start = Number.parseInt(hunk[3]!, 10);
			current.intervals.push({
				start: Math.max(1, start),
				end: Math.max(1, start) + Math.max(1, newCount) - 1,
			});
			continue;
		}
		const newHeader = DIFF_FILE_HEADER_RE.exec(line);
		if (newHeader !== null) {
			const target = newHeader[1]!.trim();
			// Keep the pending queue when the new side is /dev/null: that pair
			// is a deletion, and the file still deserves an entry. A queued old
			// name EQUAL to the new target simply paired with it; anything else
			// stays queued for the section boundary / EOF (a truncated patch
			// series must not lose its earlier files, and a rename's old path
			// genuinely changed too).
			if (target === '/dev/null') continue;
			const pairedIndex = pendingOldPaths.indexOf(target);
			if (pairedIndex !== -1) pendingOldPaths.splice(pairedIndex, 1);
			current = entryFor(target);
			continue;
		}
		const oldHeader = DIFF_OLD_HEADER_RE.exec(line);
		if (oldHeader !== null) {
			// A `--- a/x` becomes an entry only when no `+++` follows it; the
			// new-file header (the authoritative name) claims its own path.
			if (current === null) pendingOldPaths.push(oldHeader[1]!.trim());
			continue;
		}
		if (/^diff --git /.test(line)) {
			flushPendingOldPaths();
			current = null;
		}
	}
	flushPendingOldPaths();
	if (byPath.size === 0) {
		throw new Error(
			'diff contains no parseable file headers (expected "+++ b/<path>" or "--- a/<path>" lines)',
		);
	}
	return {
		files: [...byPath.values()],
		filesSeen,
		filesTruncated,
		hunksTruncated,
	};
}

/**
 * Sanitize one path parsed out of diff text: strip quoting, reject absolute
 * paths and traversal, and refuse anything outside a conservative path
 * character set (path text is user-supplied and must never be echoed raw).
 */
function sanitizeDiffPath(p: string): string | null {
	let target = p.trim();
	if (target.startsWith('"') && target.endsWith('"') && target.length >= 2) {
		target = target.slice(1, -1);
	}
	target = target.replace(/\\/g, '/');
	if (
		target.length === 0 ||
		target === '/dev/null' ||
		/^[a-zA-Z]:\//.test(target) ||
		target.startsWith('/') ||
		containsPathTraversal(target)
	) {
		return null;
	}
	if (/[^A-Za-z0-9._\-/@ +()]/.test(target)) return null;
	return normalizeGraphPath(target);
}

export function getDiffContext(
	graph: RepoGraph,
	options: {
		files?: string[];
		diff?: string;
		maxDepth?: number;
		topN?: number;
	},
): DiffContextResult {
	const maxDepth = options.maxDepth ?? 2;
	const topN = options.topN ?? DIFF_DEFAULT_TOP_N;
	const warnings: string[] = [];
	const granularity: 'hunk' | 'file' =
		options.diff !== undefined ? 'hunk' : 'file';

	let parsed: ParsedDiffFile[];
	let filesDropped = 0;
	if (options.diff !== undefined) {
		const result = parseUnifiedDiff(options.diff);
		if (result.hunksTruncated) {
			warnings.push(`diff hunk parse capped at ${DIFF_MAX_HUNKS} hunks`);
		}
		if (result.filesTruncated) {
			warnings.push(
				`diff file parse capped at ${DIFF_MAX_FILES} files (${result.filesSeen} seen)`,
			);
		}
		filesDropped = Math.max(0, result.filesSeen - result.files.length);
		parsed = result.files;
	} else if (options.files !== undefined && options.files.length > 0) {
		parsed = options.files.slice(0, DIFF_MAX_FILES).map((file) => ({
			file,
			intervals: null,
			note: 'file-level granularity: pass a unified diff to map changes to specific symbols',
		}));
		filesDropped = Math.max(0, options.files.length - parsed.length);
	} else {
		throw new Error('diff_context requires `files` or `diff`');
	}

	const fileSummaries: DiffFileSummary[] = [];
	const knownChangedRelFiles: string[] = [];
	// OW-1: every drop channel must roll into the budget envelope — an
	// unsafe-path skip and a per-file top_n drop are DROPS, not just warnings,
	// or `budget.dropped`/`truncated` would report a false all-clear.
	let unsafePathDrops = 0;
	let symbolsDropped = 0;
	for (const entry of parsed) {
		const safe = sanitizeDiffPath(entry.file);
		if (safe === null) {
			unsafePathDrops++;
			warnings.push(
				`skipped unsafe or non-graph path in diff: ${entry.file
					.replace(/[^\x20-\x7e]/g, '?')
					.slice(0, 80)}`,
			);
			continue;
		}
		const node = getGraphNode(graph, safe);
		if (!node) {
			fileSummaries.push({
				file: safe,
				known: false,
				symbols: [],
				note: 'file not present in graph (added, deleted, or unscanned)',
			});
			continue;
		}
		const fileRel = rel(graph, node.filePath);
		knownChangedRelFiles.push(fileRel);
		const symbols: DiffSymbolChange[] = [];
		let symbolDropped = 0;
		for (const symbol of Object.keys(node.exportRanges ?? {})) {
			const range = ownEntry(node.exportRanges, symbol);
			if (range === undefined) continue;
			let changedLines: number[] = [];
			if (entry.intervals !== null) {
				for (const interval of entry.intervals) {
					const from = Math.max(interval.start, range.startLine);
					const to = Math.min(interval.end, range.endLine);
					for (let l = from; l <= to; l++) changedLines.push(l);
					if (changedLines.length >= DIFF_CHANGED_LINES_CAP) {
						changedLines = changedLines.slice(0, DIFF_CHANGED_LINES_CAP);
						break;
					}
				}
				if (changedLines.length === 0) continue;
			}
			if (symbols.length >= topN) {
				symbolDropped++;
				continue;
			}
			symbols.push({
				symbol,
				kind: symbolKindOf(node, symbol),
				startLine: range.startLine,
				endLine: range.endLine,
				changedLines,
			});
		}
		if (symbolDropped > 0) {
			symbolsDropped += symbolDropped;
			warnings.push(
				`${symbolDropped} changed symbol(s) omitted in ${fileRel} by top_n=${topN}`,
			);
		}
		fileSummaries.push({
			file: fileRel,
			known: true,
			symbols,
			...(entry.note !== undefined ? { note: entry.note } : {}),
		});
	}

	// File-level impact over the union of known changed files.
	const blast = getBlastRadius(graph, knownChangedRelFiles, maxDepth);
	const impactFiles = [
		...new Set([...blast.directDependents, ...blast.transitiveDependents]),
	].sort();
	const impactTests = impactFiles
		.filter((file) => {
			const fileNode = getGraphNode(graph, file);
			return fileNode?.ontology?.roles.includes('test_file') === true;
		})
		.slice(0, CONE_ONTOLOGY_CAP);
	const impactNotes: string[] = [];
	if (blast.transitiveDependents.length > 0) {
		impactNotes.push(
			`transitive spread: ${blast.transitiveDependents.length} file(s) beyond direct dependents`,
		);
	}
	if (impactTests.length > 0) {
		impactNotes.push(`test files affected: ${impactTests.length}`);
	}
	const impactDropped = Math.max(0, impactFiles.length - topN);
	if (impactDropped > 0) {
		warnings.push(`${impactDropped} impacted file(s) omitted by top_n=${topN}`);
	}

	// OW-1: the envelope counts every drop channel — parse caps, unsafe-path
	// skips, per-file symbol top_n drops, and impact-file drops. A caller
	// reading `budget.dropped === 0` as "nothing was omitted" must be right.
	const dropped =
		filesDropped + unsafePathDrops + symbolsDropped + impactDropped;
	return {
		granularity,
		files: fileSummaries,
		impact: {
			files: impactFiles.slice(0, topN),
			tests: impactTests,
			risk: blast.riskLevel,
			notes: impactNotes,
		},
		budget: {
			returned: fileSummaries.length,
			dropped,
		},
		truncated: dropped > 0,
		warnings,
	};
}

// ============ graph_explain ============

export function explainGraphEntry(
	graph: RepoGraph,
	options: {
		file: string;
		symbol?: string;
		line?: number;
		topN?: number;
	},
): GraphExplainResult {
	const topN = options.topN ?? EXPLAIN_DEFAULT_TOP_N;
	const warnings: string[] = [];
	const node = getGraphNode(graph, options.file);
	const fileRel = node ? rel(graph, node.filePath) : options.file;

	// Line → owning symbol: smallest containing own-property range wins.
	let resolvedSpan: GraphExplainResult['resolvedSpan'];
	if (node && options.line !== undefined) {
		let best: { symbol: string; startLine: number; endLine: number } | null =
			null;
		for (const symbol of Object.keys(node.exportRanges ?? {})) {
			const span = ownEntry(node.exportRanges, symbol);
			if (span === undefined) continue;
			if (
				options.line >= span.startLine &&
				options.line <= span.endLine &&
				(best === null ||
					span.endLine - span.startLine < best.endLine - best.startLine)
			) {
				best = {
					symbol,
					startLine: span.startLine,
					endLine: span.endLine,
				};
			}
		}
		if (best !== null) {
			resolvedSpan = best;
		}
	}
	const effectiveSymbol = options.symbol ?? resolvedSpan?.symbol ?? null;

	const reasons: ExplainReason[] = [];
	if (node && effectiveSymbol !== null) {
		const range = ownEntry(node.exportRanges, effectiveSymbol);
		const line =
			ownEntry(node.exportLines, effectiveSymbol) ?? range?.startLine ?? 0;
		if (line > 0 || range !== undefined) {
			reasons.push({
				type: 'definition',
				file: fileRel,
				symbol: effectiveSymbol,
				kind: symbolKindOf(node, effectiveSymbol),
			});
		}
		const { forward, reverse } = symbolEdgeMaps(graph);
		const key = symbolKey(node, effectiveSymbol);
		let legacyEdges = 0;
		const isLegacy = (edge: SymbolEdge): boolean =>
			edge.confidence === undefined && edge.resolution === undefined;
		for (const edge of reverse.get(key) ?? []) {
			if (isLegacy(edge)) legacyEdges++;
			reasons.push({
				type: 'referenced_by',
				file: rel(graph, edge.fromFile),
				symbol: edge.fromSymbol,
				kind: symbolKindOf(
					graph.nodes[normalizeGraphPath(edge.fromFile)],
					edge.fromSymbol,
				),
				...(edge.kind !== undefined ? { relationshipKind: edge.kind } : {}),
				...(edge.confidence !== undefined
					? { confidence: edge.confidence }
					: {}),
				...(edge.resolution !== undefined
					? { resolution: edge.resolution }
					: {}),
				...(edge.evidence !== undefined && edge.evidence.length > 0
					? { evidence: edge.evidence.slice(0, EXPLAIN_EVIDENCE_CAP) }
					: {}),
			});
		}
		for (const edge of forward.get(key) ?? []) {
			if (isLegacy(edge)) legacyEdges++;
			reasons.push({
				type: 'references',
				file: rel(graph, edge.toFile),
				symbol: edge.toSymbol,
				kind: symbolKindOf(
					graph.nodes[normalizeGraphPath(edge.toFile)],
					edge.toSymbol,
				),
				...(edge.kind !== undefined ? { relationshipKind: edge.kind } : {}),
				...(edge.confidence !== undefined
					? { confidence: edge.confidence }
					: {}),
				...(edge.resolution !== undefined
					? { resolution: edge.resolution }
					: {}),
				...(edge.evidence !== undefined && edge.evidence.length > 0
					? { evidence: edge.evidence.slice(0, EXPLAIN_EVIDENCE_CAP) }
					: {}),
			});
		}
		if (legacyEdges > 0) {
			warnings.push(
				`${legacyEdges} legacy symbol edge(s) lack confidence/resolution metadata; rebuild with repo_map action="build" to score them`,
			);
		}
	}

	// File-level import relationships (both modes, under the same topN).
	for (const ref of getImporters(graph, fileRel)) {
		reasons.push({ type: 'imported_by', file: ref.file, kind: null });
	}
	for (const ref of getDependencies(graph, fileRel)) {
		reasons.push({ type: 'imports', file: ref.file, kind: null });
	}

	const definition =
		node && effectiveSymbol !== null
			? (() => {
					const range = ownEntry(node.exportRanges, effectiveSymbol);
					const line =
						ownEntry(node.exportLines, effectiveSymbol) ??
						range?.startLine ??
						0;
					if (line === 0 && range === undefined) return undefined;
					return {
						file: fileRel,
						symbol: effectiveSymbol,
						kind: symbolKindOf(node, effectiveSymbol),
						visibility: visibilityOf(node, effectiveSymbol),
						startLine: line,
						endLine: range?.endLine ?? null,
					};
				})()
			: undefined;

	if (!node) {
		warnings.push(`target file not found in graph: ${fileRel}`);
	}
	const returned = reasons.slice(0, topN);
	const dropped = reasons.length - returned.length;
	if (dropped > 0) {
		warnings.push(`${dropped} reason(s) omitted by top_n=${topN}`);
	}

	return {
		target: {
			file: fileRel,
			symbol: effectiveSymbol,
			line: options.line ?? null,
		},
		fileKnown: node !== undefined,
		...(resolvedSpan !== undefined ? { resolvedSpan } : {}),
		...(definition !== undefined ? { definition } : {}),
		reasons: returned,
		budget: { returned: returned.length, dropped },
		warnings,
	};
}
