import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokens } from '../../hooks/utils';
import {
	containsControlChars,
	containsPathTraversal,
	isCanonicalPathWithinRoot,
} from '../../utils/path-security';
import { isAssetEdge } from './builder';
import type { FreshnessProbe } from './freshness';
import {
	isCompleteSymbolEdge,
	LOW_CONFIDENCE_SYMBOL_EDGE_THRESHOLD,
} from './symbol-edge';
import type {
	BlastRadiusResult,
	CallerReference,
	ContextPackCoverage,
	ContextPackResult,
	ContextPackSnippet,
	ContextPackSourceMode,
	ContextPackSpan,
	DeadExportCandidate,
	DeadExportsResult,
	FileOntology,
	FileReference,
	FileRole,
	GraphEdge,
	GraphExtractionFailure,
	GraphHealthResult,
	GraphNode,
	GraphUnresolvedImport,
	LocalizationBlock,
	PackageBoundarySummary,
	RepoGraph,
	SymbolEdge,
	SymbolReference,
} from './types';
import {
	inferPackageBoundary,
	isSchemaVersionAtLeast,
	normalizeGraphPath,
} from './types';

const GRAPH_HEALTH_OUTPUT_LIMIT = 50;
const MAX_HEALTH_PATH_LENGTH = 500;
const MAX_QUERY_SOURCE_BYTES = 1024 * 1024;

interface QueryIndexes {
	index: Map<string, FileReference[]>;
	forwardIndex: Map<string, FileReference[]>;
	moduleNameIndex: Map<string, GraphNode>;
}

/**
 * Derived query indexes, keyed by graph object identity (issue #1534).
 *
 * This was a module-level SINGLE-SLOT cache. A single slot is correct only
 * while exactly one `RepoGraph` object is live: the moment a second graph is
 * queried, the first one's indexes are evicted and must be rebuilt from
 * scratch — O(nodes + edges). `loadSubgraphForFiles`
 * (`src/tools/repo-graph/indexed-storage.ts`) returns a FRESH `RepoGraph` per
 * call, so under a single slot every injection-hook subgraph query would evict
 * the index for the long-lived graph object `repo_map` reuses
 * (`src/tools/repo-map.ts`), forcing a full-graph index rebuild on every
 * interleaved call. A `WeakMap` keyed by the graph object removes that thrash
 * by construction and lets both graphs keep their own indexes; entries are
 * collected with their graph, so there is no unbounded growth
 * (AGENTS.md invariant 8).
 *
 * CONTRACT — read before mutating a graph in place: the single slot used to
 * flush *incidentally* whenever any other graph was queried, which sometimes
 * masked a missing invalidation. The WeakMap removes that accident. Any site
 * that mutates `graph.nodes` or `graph.edges` in place MUST call
 * {@link resetQueryCache} afterwards, or its stale indexes persist for the
 * lifetime of the graph object. Existing in-place mutation sites already do
 * this (`src/tools/repo-graph/incremental.ts:429,722,742`); the WeakMap
 * preserves that contract rather than creating it, and
 * `query-index-cache.test.ts` pins it.
 */
let queryIndexCache = new WeakMap<RepoGraph, QueryIndexes>();

function normalizeLookupPath(input: string): string {
	return normalizeGraphPath(input).replace(/^(?:\.\/)+/, '');
}

function graphRoot(graph: RepoGraph): string {
	return path.resolve(graph.workspaceRoot);
}

function toModuleName(graph: RepoGraph, input: string): string {
	const normalized = normalizeLookupPath(input);
	if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) {
		return normalizeLookupPath(path.relative(graphRoot(graph), normalized));
	}
	return normalized;
}

function absoluteKeyForModule(graph: RepoGraph, moduleName: string): string {
	return normalizeGraphPath(path.resolve(graphRoot(graph), moduleName));
}

export function getGraphNode(
	graph: RepoGraph,
	input: string,
): GraphNode | undefined {
	const moduleName = toModuleName(graph, input);
	const direct = graph.nodes[absoluteKeyForModule(graph, moduleName)];
	if (direct) return direct;
	return getQueryIndexes(graph).moduleNameIndex.get(moduleName);
}

function moduleNameForEdgePath(graph: RepoGraph, edgePath: string): string {
	const key = normalizeGraphPath(edgePath);
	const node = graph.nodes[key];
	if (node) return normalizeLookupPath(node.moduleName);
	return normalizeLookupPath(path.relative(graphRoot(graph), edgePath));
}

function buildQueryIndexes(graph: RepoGraph): QueryIndexes {
	const reverse = new Map<string, FileReference[]>();
	const forward = new Map<string, FileReference[]>();
	const moduleNameIndex = new Map<string, GraphNode>();
	for (const node of Object.values(graph.nodes)) {
		moduleNameIndex.set(normalizeLookupPath(node.moduleName), node);
	}
	for (const edge of graph.edges) {
		// Asset edges (e.g. import './data.json') never have a target node and
		// must not count toward in-degree / importer / dependent rankings
		// (issue #1985, defect A1).
		if (isAssetEdge(edge)) continue;
		const source = normalizeGraphPath(edge.source);
		const target = normalizeGraphPath(edge.target);
		const sourceRef: FileReference = {
			file: moduleNameForEdgePath(graph, edge.source),
			importType: edge.importType,
		};
		const targetRef: FileReference = {
			file: moduleNameForEdgePath(graph, edge.target),
			importType: edge.importType,
		};
		const reverseRefs = reverse.get(target);
		if (reverseRefs) reverseRefs.push(sourceRef);
		else reverse.set(target, [sourceRef]);
		const forwardRefs = forward.get(source);
		if (forwardRefs) forwardRefs.push(targetRef);
		else forward.set(source, [targetRef]);
	}
	for (const refs of reverse.values()) {
		refs.sort((a, b) => a.file.localeCompare(b.file));
	}
	for (const refs of forward.values()) {
		refs.sort((a, b) => a.file.localeCompare(b.file));
	}
	return {
		index: reverse,
		forwardIndex: forward,
		moduleNameIndex,
	};
}

function getQueryIndexes(graph: RepoGraph): QueryIndexes {
	const cached = queryIndexCache.get(graph);
	if (cached) return cached;
	const built = buildQueryIndexes(graph);
	queryIndexCache.set(graph, built);
	return built;
}

function getReverseIndex(graph: RepoGraph): Map<string, FileReference[]> {
	return getQueryIndexes(graph).index;
}

function getForwardIndex(graph: RepoGraph): Map<string, FileReference[]> {
	return getQueryIndexes(graph).forwardIndex;
}

/**
 * Drop every cached query index. Required after any in-place mutation of a
 * graph's `nodes` or `edges` (see the {@link queryIndexCache} contract note),
 * and retained as the test seam for index-staleness assertions. Reassigns a
 * fresh `WeakMap` rather than deleting keys, so it invalidates graphs this
 * module can no longer enumerate.
 */
export function resetQueryCache(): void {
	queryIndexCache = new WeakMap();
}

/**
 * @deprecated Graph age is not a content-freshness signal. Internal consumers
 * use {@link probeFreshness}; this compatibility helper intentionally retains
 * its historical five-minute TTL semantics for external callers.
 */
export function isGraphFresh(
	graph: RepoGraph | null,
	maxAgeMs: number = 5 * 60 * 1000,
): boolean {
	if (!graph) return false;
	const built = Date.parse(graph.metadata?.generatedAt ?? '');
	if (!Number.isFinite(built)) return false;
	return Date.now() - built <= maxAgeMs;
}

function isSafeHealthPath(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.length === 0 || value.length > MAX_HEALTH_PATH_LENGTH) return false;
	if (containsControlChars(value) || containsPathTraversal(value)) return false;
	if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
	return true;
}

function isSafeHealthText(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.length === 0 || value.length > MAX_HEALTH_PATH_LENGTH) return false;
	if (containsControlChars(value)) return false;
	return true;
}

function cap<T>(entries: T[]): T[] {
	return entries.slice(0, GRAPH_HEALTH_OUTPUT_LIMIT);
}

function sanitizeExtractionFailures(value: unknown): GraphExtractionFailure[] {
	if (!Array.isArray(value)) return [];
	const entries: GraphExtractionFailure[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const entry = raw as Partial<GraphExtractionFailure>;
		if (
			isSafeHealthPath(entry.file) &&
			isSafeHealthText(entry.language) &&
			isSafeHealthText(entry.reason)
		) {
			entries.push({
				file: entry.file,
				language: entry.language,
				reason: entry.reason,
			});
		}
	}
	return cap(entries);
}

function sanitizeUnresolvedImports(value: unknown): GraphUnresolvedImport[] {
	if (!Array.isArray(value)) return [];
	const entries: GraphUnresolvedImport[] = [];
	for (const raw of value) {
		if (!raw || typeof raw !== 'object') continue;
		const entry = raw as Partial<GraphUnresolvedImport>;
		if (isSafeHealthPath(entry.file) && isSafeHealthText(entry.specifier)) {
			entries.push({ file: entry.file, specifier: entry.specifier });
		}
	}
	return cap(entries);
}

function sanitizePathList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return cap(value.filter(isSafeHealthPath));
}

function getProbeStaleFiles(
	probe: FreshnessProbe | undefined,
	workspaceRoot: string,
): string[] {
	if (!probe) return [];
	const root = path.resolve(workspaceRoot);
	const stale = new Set<string>();
	for (const absolutePath of [...probe.changed, ...probe.removed]) {
		if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
			continue;
		}
		const relative = normalizeGraphPath(path.relative(root, absolutePath));
		if (!isSafeHealthPath(relative)) continue;
		stale.add(relative);
	}
	return [...stale]
		.sort((a, b) => a.localeCompare(b))
		.slice(0, GRAPH_HEALTH_OUTPUT_LIMIT);
}

export function getGraphHealth(
	graph: RepoGraph | null,
	workspaceRoot?: string,
	probe?: FreshnessProbe,
): GraphHealthResult {
	const probeState = probe?.state ?? 'no-fingerprint';
	if (!graph) {
		return {
			schemaVersion: null,
			fresh: false,
			probeState,
			staleFiles: [],
			extractionFailures: [],
			unresolvedImports: [],
			oversizedFiles: [],
			unsupportedFiles: [],
			binaryFiles: [],
			unreadableFiles: [],
			validationSkippedFiles: [],
			lowConfidenceEdgeCount: 0,
			unresolvedSymbolEdgeCount: 0,
			walkTruncated: false,
			walkTruncationReason: null,
			incrementalFallbacks: 0,
			notes: [
				'No repo graph found at .swarm/repo-graph.json. Run repo_map with action="build" first.',
			],
		};
	}

	const diagnostics = graph.diagnostics as Record<string, unknown> | undefined;
	const rawSymbolEdges = graph.symbolEdges ?? [];
	const completeSymbolEdges = rawSymbolEdges.filter(isCompleteSymbolEdge);
	const legacySymbolEdgeCount =
		rawSymbolEdges.length - completeSymbolEdges.length;
	const fresh = probeState === 'clean';
	const staleFiles = getProbeStaleFiles(
		probe,
		workspaceRoot ?? graph.workspaceRoot,
	);
	const notes: string[] = [];
	if (probeState === 'drifted') {
		notes.push(
			'Graph content is stale relative to the workspace. Run repo_map with action="build" if automatic refresh is unavailable.',
		);
	} else if (probeState === 'no-fingerprint') {
		notes.push(
			'Graph has no matching content fingerprint. Run repo_map with action="build" to certify it.',
		);
	} else if (probeState === 'inconclusive') {
		notes.push(
			'Graph freshness is unknown because the bounded workspace probe did not complete; no refresh or deletion was attempted.',
		);
	}
	if (!diagnostics) {
		notes.push(
			'Graph has no recorded diagnostics. Rebuild with repo_map action="build" to collect health details.',
		);
	}
	if (legacySymbolEdgeCount > 0) {
		notes.push(
			`${legacySymbolEdgeCount} legacy symbol edge(s) have no confidence or resolution metadata; rebuild the graph to score them.`,
		);
	}
	const binaryFiles = sanitizePathList(diagnostics?.binaryFiles);
	const binaryCount = binaryFiles.length;
	if (binaryCount > 0) {
		notes.push(`${binaryCount} binary files skipped during last build.`);
	}
	const unreadableFiles = sanitizePathList(diagnostics?.unreadableFiles);
	const unreadableCount = unreadableFiles.length;
	if (unreadableCount > 0) {
		notes.push(
			`${unreadableCount} unreadable files skipped during last build.`,
		);
	}

	// Walk-truncation + incremental-fallback diagnostics (issue #1985, A7).
	const walkTruncated = diagnostics?.walkTruncated === true;
	const rawReason = diagnostics?.walkTruncationReason;
	const walkTruncationReason: 'budget' | 'cap' | null =
		rawReason === 'budget' || rawReason === 'cap' ? rawReason : null;
	const incrementalFallbacks =
		typeof diagnostics?.incrementalFallbacks === 'number' &&
		Number.isFinite(diagnostics.incrementalFallbacks) &&
		diagnostics.incrementalFallbacks > 0
			? Math.floor(diagnostics.incrementalFallbacks)
			: 0;
	if (walkTruncated) {
		notes.push(
			'Graph is INCOMPLETE: walk hit the file-cap/wall-clock budget — results may be missing files.' +
				(walkTruncationReason ? ` (reason: ${walkTruncationReason})` : ''),
		);
	}
	if (incrementalFallbacks > 0) {
		notes.push(
			`${incrementalFallbacks} incremental update(s) fell back to a full rebuild (validation failure or concurrent modification).`,
		);
	}

	return {
		schemaVersion: graph.schema_version,
		fresh,
		probeState,
		staleFiles,
		extractionFailures: sanitizeExtractionFailures(
			diagnostics?.extractionFailures,
		),
		unresolvedImports: sanitizeUnresolvedImports(
			diagnostics?.unresolvedImports,
		),
		oversizedFiles: sanitizePathList(diagnostics?.oversizedFiles),
		unsupportedFiles: sanitizePathList(diagnostics?.unsupportedFiles),
		binaryFiles,
		unreadableFiles,
		validationSkippedFiles: sanitizePathList(
			diagnostics?.validationSkippedFiles,
		),
		lowConfidenceEdgeCount:
			completeSymbolEdges.length > 0
				? completeSymbolEdges.filter(
						(edge) => edge.confidence < LOW_CONFIDENCE_SYMBOL_EDGE_THRESHOLD,
					).length
				: typeof diagnostics?.lowConfidenceEdgeCount === 'number' &&
						Number.isFinite(diagnostics.lowConfidenceEdgeCount) &&
						diagnostics.lowConfidenceEdgeCount > 0
					? Math.floor(diagnostics.lowConfidenceEdgeCount)
					: 0,
		unresolvedSymbolEdgeCount: completeSymbolEdges.filter(
			(edge) => edge.resolution === 'unresolved',
		).length,
		walkTruncated,
		walkTruncationReason,
		incrementalFallbacks,
		notes,
	};
}

export function getImporters(
	graph: RepoGraph,
	filePath: string,
): FileReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	return getReverseIndex(graph).get(normalizeGraphPath(node.filePath)) ?? [];
}

export function getDependencies(
	graph: RepoGraph,
	filePath: string,
): FileReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	const sourceKey = normalizeGraphPath(node.filePath);
	return getForwardIndex(graph).get(sourceKey) ?? [];
}

export function getSymbolConsumers(
	graph: RepoGraph,
	filePath: string,
	symbolName: string,
): SymbolReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	const targetKey = normalizeGraphPath(node.filePath);
	const refs: SymbolReference[] = [];
	for (const edge of graph.edges) {
		if (isAssetEdge(edge)) continue;
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		const importedSymbols = edge.importedSymbols ?? [];
		if (edge.importType === 'namespace') {
			refs.push({
				file: moduleNameForEdgePath(graph, edge.source),
				importedAs: '*',
			});
			continue;
		}
		if (importedSymbols.includes(symbolName)) {
			refs.push({
				file: moduleNameForEdgePath(graph, edge.source),
				importedAs: symbolName,
			});
		}
	}
	refs.sort((a, b) => a.file.localeCompare(b.file));
	return refs;
}

/**
 * Files that actually *reference* an exported symbol of `filePath` — call-site
 * granularity, not just "imports the file". On schema >= 1.1.0 graphs this uses
 * per-edge `usedSymbols`; on older graphs (or namespace imports) it falls back
 * to import-level matching, flagged via `resolution: 'imported'`.
 */
export function getCallers(
	graph: RepoGraph,
	filePath: string,
	symbolName: string,
): CallerReference[] {
	const node = getGraphNode(graph, filePath);
	if (!node) return [];
	const targetKey = normalizeGraphPath(node.filePath);
	const refs: CallerReference[] = [];
	const seen = new Set<string>();
	for (const edge of graph.edges) {
		if (isAssetEdge(edge)) continue;
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		const file = moduleNameForEdgePath(graph, edge.source);
		if (seen.has(file)) continue;
		if (edge.usedSymbols !== undefined) {
			if (edge.usedSymbols.includes(symbolName)) {
				seen.add(file);
				refs.push({ file, resolution: 'used' });
			}
			continue;
		}
		// Fallback: schema < 1.1.0, or an import type without resolvable usage.
		const imported = edge.importedSymbols ?? [];
		if (edge.importType === 'namespace' || imported.includes(symbolName)) {
			seen.add(file);
			refs.push({ file, resolution: 'imported' });
		}
	}
	refs.sort((a, b) => a.file.localeCompare(b.file));
	return refs;
}

/**
 * Roles whose exports are invoked by frameworks/tooling rather than in-repo
 * imports (entry points, routes, tests), so their unused-export signal is noise.
 */
const DEAD_EXPORT_EXCLUDED_ROLES = new Set<FileRole>([
	'api_route',
	'cli_command',
	'test_file',
	'agent',
	'hook',
	'middleware',
]);

export interface DeadExportsOptions {
	/** Max candidates returned (default 100). */
	maxCandidates?: number;
}

/**
 * Conservatively detect exported symbols with no detected in-repo reference.
 *
 * Scoping for precision (advisory "candidate" output, never a delete directive):
 *   - Requires schema >= 1.1.0 (per-edge usedSymbols); otherwise returns
 *     schemaSupported=false so the caller can prompt a rebuild.
 *   - Only considers files imported by >= 1 other file — a file with no
 *     importers is a likely public-API entry / CLI / test, not dead code.
 *   - Skips files imported anywhere via namespace/side-effect/require/dynamic
 *     imports, where per-symbol usage is unresolvable.
 *   - Excludes framework-invoked roles (routes, CLIs, tests, agents, hooks,
 *     middleware) and the synthetic 'default' export.
 */
export function getDeadExports(
	graph: RepoGraph,
	options?: DeadExportsOptions,
): DeadExportsResult {
	if (!isSchemaVersionAtLeast(graph.schema_version, '1.1.0')) {
		return {
			schemaSupported: false,
			analyzedFiles: 0,
			skippedUnresolvable: 0,
			candidates: [],
			note: 'Graph predates schema 1.1.0 (no usedSymbols data). Run repo_map action="build" to enable dead_exports.',
		};
	}

	// One O(edges) pass: per target, union of used symbols + unresolvable flag.
	const usage = new Map<string, { used: Set<string>; unresolvable: boolean }>();
	for (const edge of graph.edges) {
		// Asset edges carry no node-level usage signal (their target never
		// became a node), so they cannot contribute to dead-export analysis.
		if (isAssetEdge(edge)) continue;
		const target = normalizeGraphPath(edge.target);
		let entry = usage.get(target);
		if (!entry) {
			entry = { used: new Set<string>(), unresolvable: false };
			usage.set(target, entry);
		}
		if (
			edge.importType === 'namespace' ||
			edge.importType === 'sideeffect' ||
			edge.importType === 'require'
		) {
			entry.unresolvable = true;
		} else if (edge.usedSymbols) {
			for (const symbol of edge.usedSymbols) entry.used.add(symbol);
		}
	}

	const reverse = getReverseIndex(graph);
	const candidates: DeadExportCandidate[] = [];
	let analyzedFiles = 0;
	let skippedUnresolvable = 0;

	for (const node of Object.values(graph.nodes)) {
		if (node.exports.length === 0) continue;
		const key = normalizeGraphPath(node.filePath);
		const importerCount = reverse.get(key)?.length ?? 0;
		if (importerCount === 0) continue;
		const roles = node.ontology?.roles ?? [];
		if (roles.some((r) => DEAD_EXPORT_EXCLUDED_ROLES.has(r))) continue;
		const entry = usage.get(key);
		if (entry?.unresolvable) {
			skippedUnresolvable++;
			continue;
		}
		analyzedFiles++;
		const used = entry?.used ?? new Set<string>();
		for (const symbol of node.exports) {
			if (symbol === 'default') continue;
			if (used.has(symbol)) continue;
			candidates.push({
				file: node.moduleName,
				symbol,
				// Own-property guard: `exportLines` is a plain object literal, so a
				// symbol named `constructor`/`toString`/… would otherwise resolve
				// through the prototype chain to a function and be reported as a
				// line number. See the same guard in getContextPack.
				line:
					node.exportLines !== undefined &&
					Object.hasOwn(node.exportLines, symbol)
						? node.exportLines[symbol]
						: undefined,
				importerCount,
			});
		}
	}

	candidates.sort(
		(a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
	);
	const limit = options?.maxCandidates ?? 100;
	const truncated = candidates.length > limit;
	return {
		schemaSupported: true,
		analyzedFiles,
		skippedUnresolvable,
		candidates: candidates.slice(0, limit),
		note:
			'Advisory: exported symbols with no detected in-repo reference, limited to files imported by >=1 other file. ' +
			'Regex analysis cannot see dynamic dispatch, string-keyed access, or namespace/barrel re-export usage; verify before removing.' +
			(truncated ? ` Showing ${limit} of ${candidates.length}.` : ''),
	};
}

export function getBlastRadius(
	graph: RepoGraph,
	filePaths: string[],
	maxDepth = 3,
): BlastRadiusResult {
	const targetNodes = filePaths
		.map((filePath) => getGraphNode(graph, filePath))
		.filter((node): node is GraphNode => node !== undefined);
	const targets = targetNodes.map((node) =>
		normalizeLookupPath(node.moduleName),
	);
	if (maxDepth <= 0 || targetNodes.length === 0) {
		return {
			target: filePaths.map((filePath) => toModuleName(graph, filePath)),
			directDependents: [],
			transitiveDependents: [],
			depthReached: 0,
			totalDependents: 0,
			riskLevel: 'low',
		};
	}

	const reverse = getReverseIndex(graph);
	const visited = new Set(
		targetNodes.map((node) => normalizeGraphPath(node.filePath)),
	);
	const direct = new Set<string>();
	const transitive = new Set<string>();
	let depthReached = 0;
	let queue = targetNodes.map((node) => ({
		key: normalizeGraphPath(node.filePath),
		depth: 0,
	}));

	while (queue.length > 0) {
		const next: typeof queue = [];
		for (const { key, depth } of queue) {
			const importers = reverse.get(key) ?? [];
			for (const ref of importers) {
				const importerNode = getGraphNode(graph, ref.file);
				if (!importerNode) continue;
				const importerKey = normalizeGraphPath(importerNode.filePath);
				if (visited.has(importerKey)) continue;
				visited.add(importerKey);
				if (depth === 0) direct.add(ref.file);
				else transitive.add(ref.file);
				depthReached = Math.max(depthReached, depth + 1);
				if (depth + 1 < maxDepth) {
					next.push({ key: importerKey, depth: depth + 1 });
				}
			}
		}
		queue = next;
	}

	const totalDependents = direct.size + transitive.size;
	return {
		target: targets,
		directDependents: [...direct].sort(),
		transitiveDependents: [...transitive].sort(),
		depthReached,
		totalDependents,
		riskLevel: classifyRisk(totalDependents),
	};
}

function classifyRisk(count: number): BlastRadiusResult['riskLevel'] {
	if (count <= 3) return 'low';
	if (count <= 10) return 'medium';
	if (count <= 25) return 'high';
	return 'critical';
}

export function getKeyFiles(graph: RepoGraph, topN = 10): GraphNode[] {
	const reverse = getReverseIndex(graph);
	const scored = Object.values(graph.nodes).map((node) => ({
		node,
		inDegree: reverse.get(normalizeGraphPath(node.filePath))?.length ?? 0,
	}));
	scored.sort((a, b) => {
		if (b.inDegree !== a.inDegree) return b.inDegree - a.inDegree;
		return a.node.moduleName.localeCompare(b.node.moduleName);
	});
	return scored.slice(0, topN).map((item) => item.node);
}

export function getFileOntology(
	graph: RepoGraph,
	filePath: string,
): FileOntology | null {
	return getGraphNode(graph, filePath)?.ontology ?? null;
}

export function getLocalizationContext(
	graph: RepoGraph,
	filePath: string,
	options: { maxImporters?: number; maxDeps?: number; maxDepth?: number } = {},
): LocalizationBlock {
	const target = toModuleName(graph, filePath);
	const node = getGraphNode(graph, target);
	const importers = getImporters(graph, target);
	const dependencies = getDependencies(graph, target);
	const blast = getBlastRadius(graph, [target], options.maxDepth ?? 2);
	const externalSymbols = collectExternallyUsedSymbols(graph, node);
	const summary = formatLocalizationSummary({
		target,
		importers,
		dependencies,
		blast,
		externalSymbols,
		ontology: node?.ontology ?? null,
		maxImporters: options.maxImporters ?? 5,
		maxDeps: options.maxDeps ?? 5,
	});

	return {
		target,
		importerCount: importers.length,
		importers: importers.slice(0, options.maxImporters ?? 5),
		dependencyCount: dependencies.length,
		dependencies: dependencies.slice(0, options.maxDeps ?? 5),
		exportedSymbolsUsedExternally: externalSymbols,
		blastRadius: blast,
		summary,
	};
}

// Deterministic source-text token estimate via the canonical estimator
// (src/hooks/utils.ts — issue #1616/#2107). This was an independent /3.5 copy
// of the budget-service formula, so repo-graph summaries silently disagreed
// with every other measurement of the same text.
function estimateTextTokens(text: string): number {
	return estimateTokens(text);
}

// Signature extraction (issue #1533). Deterministic, language-agnostic:
// skip up to 3 leading decorator lines (`@…` — Python decorated_definition
// ranges start at the first decorator; TS decorators are already excluded by
// the AST), then scan at most 3 lines stopping at the first trimmed line
// ending `{` or `:` (TS-family opening brace, Python def/class colon). With
// no terminator in the window (Ruby `def foo(x)`), emit only the first
// non-decorator line. Total scan bounded at 6 lines from startLine.
function extractSignatureText(lines: string[], startLine: number): string {
	let idx = Math.max(0, startLine - 1);
	if (idx >= lines.length) return '';
	let skipped = 0;
	while (
		idx < lines.length &&
		skipped < 3 &&
		lines[idx]!.trim().startsWith('@')
	) {
		idx++;
		skipped++;
	}
	if (idx >= lines.length) return '';
	let last = idx;
	let found = false;
	for (let i = 0; i < 3 && idx + i < lines.length; i++) {
		const line = lines[idx + i]!.trim();
		if (line.endsWith('{') || line.endsWith(':')) {
			last = idx + i;
			found = true;
			break;
		}
	}
	// No terminator in the window (Ruby `def foo(x)`): emit only the first
	// non-decorator line rather than dragging body lines into the signature.
	if (!found) return lines[idx]!;
	return lines.slice(idx, last + 1).join('\n');
}

const EMPTY_COVERAGE: ContextPackCoverage = {
	reachedSymbols: 0,
	returnedSymbols: 0,
	omittedByBudget: 0,
	unresolvedEdges: 0,
	lowConfidenceEdges: 0,
};

const MAX_DETAIL_WARNINGS = 5;

function boundedDetails(details: string[], label: string): string[] {
	const out = details
		.slice(0, MAX_DETAIL_WARNINGS)
		.map((d) => `${label} for ${d}`);
	if (details.length > MAX_DETAIL_WARNINGS) {
		out.push(
			`... and ${details.length - MAX_DETAIL_WARNINGS} more ${label} cases`,
		);
	}
	return out;
}

export function getContextPack(
	graph: RepoGraph,
	file: string,
	symbol: string,
	options: {
		maxDepth?: number;
		maxTokens?: number;
		includeSource?: boolean;
		sourceMode?: ContextPackSourceMode;
		directory?: string;
	} = {},
): ContextPackResult {
	if (!isSchemaVersionAtLeast(graph.schema_version, '1.2.0')) {
		return {
			schemaSupported: false,
			target: { file, symbol },
			spans: [],
			truncated: false,
			estimatedTokens: 0,
			note: 'rebuild with repo_map action="build"',
			coverage: { ...EMPTY_COVERAGE },
			warnings: [
				'graph schema 1.2.0+ required for context packs; rebuild with repo_map action="build"',
			],
		};
	}

	const maxDepth = options.maxDepth ?? 2;
	const maxTokens = options.maxTokens ?? 4000;

	// Resolve the input file to the graph node's absolute filePath using the
	// same resolution logic as every other query function (getGraphNode handles
	// workspace-relative AND absolute inputs). graph.nodes keys and symbolEdges
	// index keys are absolute normalized paths, so a relative input like
	// 'src/foo.ts' must be resolved to its absolute filePath before lookup.
	const targetNode = getGraphNode(graph, file);
	if (!targetNode) {
		return {
			schemaSupported: true,
			target: { file, symbol },
			spans: [],
			truncated: false,
			estimatedTokens: 0,
			note: 'Target file not found in graph',
			coverage: { ...EMPTY_COVERAGE },
			warnings: [],
		};
	}
	const targetFile = normalizeGraphPath(targetNode.filePath);

	// Build per-call symbol-edge indexes: forward (outgoing callees) and
	// reverse (incoming callers), keyed by normalized file + symbol.
	const forward = new Map<string, SymbolEdge[]>();
	const reverse = new Map<string, SymbolEdge[]>();
	const symbolEdges = graph.symbolEdges ?? [];
	for (const edge of symbolEdges) {
		const fromKey = `${normalizeGraphPath(edge.fromFile)}\0${edge.fromSymbol}`;
		const toKey = `${normalizeGraphPath(edge.toFile)}\0${edge.toSymbol}`;
		const fromEdges = forward.get(fromKey);
		if (fromEdges) fromEdges.push(edge);
		else forward.set(fromKey, [edge]);
		const toEdges = reverse.get(toKey);
		if (toEdges) toEdges.push(edge);
		else reverse.set(toKey, [edge]);
	}

	// BFS both directions from the target symbol up to maxDepth inclusive.
	const targetKey = `${targetFile}\0${symbol}`;
	const visited = new Map<string, number>(); // key -> first-encountered depth
	const queue: { key: string; depth: number }[] = [
		{ key: targetKey, depth: 0 },
	];
	visited.set(targetKey, 0);
	const reached: { file: string; symbol: string; depth: number }[] = [];

	// Edge-resolution telemetry (issue #1533). Symbol-keyed (`file\0symbol`),
	// collected at first discovery so duplicate edges toward the same
	// destination count once. `lowConfidence` uses the same predicate as the
	// internal-symbol span fallback below, so coverage and spans agree. The
	// seeded target is classified too (F-002): when the target itself lacks an
	// export range it renders as an internal-symbol fallback span, and the
	// coverage count must include it. The target node always exists here (an
	// absent node returned early above), so it can never be `unresolved`.
	const unresolved = new Set<string>();
	const lowConfidence = new Set<string>();
	const targetRanges = targetNode.exportRanges;
	if (
		!(
			targetRanges !== undefined &&
			Object.hasOwn(targetRanges, symbol) &&
			targetRanges[symbol]
		)
	) {
		lowConfidence.add(targetKey);
	}
	const enqueue = (nextFile: string, nextSymbol: string, nextDepth: number) => {
		const nextKey = `${nextFile}\0${nextSymbol}`;
		if (visited.has(nextKey)) return;
		visited.set(nextKey, nextDepth);
		queue.push({ key: nextKey, depth: nextDepth });
		const node = graph.nodes[nextFile];
		if (!node) {
			unresolved.add(nextKey);
			return;
		}
		const ranges = node.exportRanges;
		const hasRange =
			ranges !== undefined &&
			Object.hasOwn(ranges, nextSymbol) &&
			ranges[nextSymbol];
		if (!hasRange) lowConfidence.add(nextKey);
	};

	let queueHead = 0;
	while (queueHead < queue.length) {
		const { key, depth } = queue[queueHead]!;
		queueHead++;
		const [curFile, curSymbol] = key.split('\0', 2);
		reached.push({ file: curFile, symbol: curSymbol, depth });

		if (depth >= maxDepth) continue;

		// Forward: follow edges where this symbol is the source (callees).
		const outEdges = forward.get(key) ?? [];
		for (const edge of outEdges) {
			enqueue(normalizeGraphPath(edge.toFile), edge.toSymbol, depth + 1);
		}

		// Reverse: follow edges where this symbol is the target (callers).
		const inEdges = reverse.get(key) ?? [];
		for (const edge of inEdges) {
			enqueue(normalizeGraphPath(edge.fromFile), edge.fromSymbol, depth + 1);
		}
	}

	// Heuristic: ~12 tokens per line for full spans, ~10 tokens for signature spans.
	const TOKENS_PER_LINE = 12;
	const TOKENS_PER_SIGNATURE = 10;

	// Build spans from exportRanges, attaching depth for ordering.
	// Internal-symbol fallback: when a BFS-reached symbol has no exportRanges
	// entry, emit a file-level signature pointer instead of silently dropping it.
	const spansWithDepth: { span: ContextPackSpan; depth: number }[] = [];
	for (const { file: symFile, symbol: sym, depth: d } of reached) {
		const node = graph.nodes[symFile];
		// `exportRanges` is a plain object literal, so a symbol named after an
		// Object.prototype member (`constructor`, `toString`, `valueOf`, …)
		// resolves through the prototype chain to a FUNCTION. That is truthy, so
		// the `!range` fallback below would not fire and the emitted span would
		// carry `startLine: undefined` and `estimatedTokens: NaN`. `constructor`
		// is a real, discoverable symbol name in every language whose members
		// this graph records, so guard the lookup by own-property.
		const ranges = node?.exportRanges;
		const range =
			ranges !== undefined && Object.hasOwn(ranges, sym)
				? ranges[sym]
				: undefined;

		if (!range) {
			spansWithDepth.push({
				span: {
					file: symFile,
					symbol: sym,
					startLine: 1,
					endLine: 1,
					mode: 'signature',
					note: 'internal symbol — span unavailable',
				},
				depth: d,
			});
			continue;
		}

		const mode: 'full' | 'signature' =
			d === 0 ? 'full' : d < maxDepth ? 'full' : 'signature';

		spansWithDepth.push({
			span: {
				file: symFile,
				symbol: sym,
				startLine: range.startLine,
				endLine: range.endLine,
				mode,
			},
			depth: d,
		});
	}

	// Relevance order: target first, then ascending depth, then file, then symbol.
	spansWithDepth.sort((a, b) => {
		const aIsTarget =
			a.span.file === targetFile && a.span.symbol === symbol ? 0 : 1;
		const bIsTarget =
			b.span.file === targetFile && b.span.symbol === symbol ? 0 : 1;
		if (aIsTarget !== bIsTarget) return aIsTarget - bIsTarget;
		if (a.depth !== b.depth) return a.depth - b.depth;
		const fileCmp = a.span.file.localeCompare(b.span.file);
		if (fileCmp !== 0) return fileCmp;
		return a.span.symbol.localeCompare(b.span.symbol);
	});

	const includeSource = options.includeSource ?? false;
	const sourceMode: ContextPackSourceMode = options.sourceMode ?? 'mixed';
	const directory = options.directory ?? graph.workspaceRoot;
	const resolvedDir = path.resolve(directory);
	const MAX_SOURCE_LINES = 80;

	const displayPath = (p: string): string => {
		if (!path.isAbsolute(p)) return p.replace(/\\/g, '/');
		try {
			return path.relative(resolvedDir, p).replace(/\\/g, '/') || p;
		} catch {
			return p;
		}
	};

	// Apply token budget; keep at least the target span if present. Packing is
	// deterministic: spans are greedily admitted in the sorted relevance order
	// above, so the same graph + options always produce the same spans. With
	// include_source the per-span cost is the char-based estimate of the
	// extracted text (issue #1533: budget over source text, not line counts);
	// span-only mode keeps the line-based heuristic.
	let estimatedTokens = 0;
	const finalSpans: ContextPackSpan[] = [];
	let truncated = false;
	const readFailures: string[] = [];
	const oversizedSources: string[] = [];
	const outsideWorkspace: string[] = [];
	const snippetKinds = new Map<
		ContextPackSpan,
		'full' | 'signature' | 'summary'
	>();

	for (const { span } of spansWithDepth) {
		let spanTokens =
			span.mode === 'full'
				? (span.endLine - span.startLine + 1) * TOKENS_PER_LINE
				: TOKENS_PER_SIGNATURE;

		if (finalSpans.length > 0 && estimatedTokens + spanTokens > maxTokens) {
			truncated = true;
			break;
		}

		if (includeSource && !span.note) {
			const absPath = path.isAbsolute(span.file)
				? span.file
				: path.resolve(resolvedDir, span.file);
			const resolved = path.resolve(absPath);
			// Canonical containment (both sides realpath'd, nearest-existing
			// ancestor walk): a missing file inside the workspace still passes
			// here and then fails the read below; a symlink/junction escape or
			// an out-of-workspace span.file fails closed.
			if (!isCanonicalPathWithinRoot(resolved, resolvedDir)) {
				span.note = 'source outside workspace';
				outsideWorkspace.push(`${displayPath(span.file)}:${span.symbol}`);
			} else {
				try {
					const stats = fs.statSync(resolved);
					if (stats.size > MAX_QUERY_SOURCE_BYTES) {
						span.note = 'source too large';
						oversizedSources.push(`${displayPath(span.file)}:${span.symbol}`);
						finalSpans.push(span);
						estimatedTokens += spanTokens;
						continue;
					}
					const content = fs.readFileSync(resolved, 'utf-8');
					const lines = content.split('\n');
					const start = Math.max(0, span.startLine - 1);
					const wantSignature =
						sourceMode === 'signature' ||
						(sourceMode === 'mixed' && span.mode === 'signature');
					if (wantSignature) {
						span.text = extractSignatureText(lines, span.startLine);
						snippetKinds.set(span, 'signature');
					} else {
						const rangeLength = span.endLine - span.startLine + 1;
						const end = Math.min(
							lines.length,
							start + MAX_SOURCE_LINES,
							span.endLine,
						);
						const slice = lines.slice(start, end);
						span.text = slice.join('\n');
						const capped =
							rangeLength > MAX_SOURCE_LINES &&
							end === start + MAX_SOURCE_LINES;
						snippetKinds.set(span, capped ? 'summary' : 'full');
					}
					spanTokens = estimateTextTokens(span.text ?? '');
				} catch {
					span.note = 'source read failed';
					readFailures.push(`${displayPath(span.file)}:${span.symbol}`);
				}
			}
		}

		finalSpans.push(span);
		estimatedTokens += spanTokens;
	}

	// Snippets: one per returned span with non-empty extracted text. Spans
	// whose read failed, fell outside the workspace, or lack an export range
	// produce no snippet (their state is visible via span.note + warnings).
	const snippets: ContextPackSnippet[] = [];
	if (includeSource) {
		for (const span of finalSpans) {
			if (span.text === undefined || span.text.length === 0) continue;
			const kind = snippetKinds.get(span) ?? 'full';
			snippets.push({
				file: span.file,
				symbol: span.symbol,
				startLine: span.startLine,
				endLine: span.endLine,
				mode: kind,
				text: span.text,
				hash: createHash('sha256').update(span.text).digest('hex'),
				// Resolution-quality score (not language grammar quality):
				// the exact target is a 1.0; resolved neighbors are 0.8. Real
				// edge confidence arrives with KG-11 (issue #1532).
				confidence:
					span.file === targetFile && span.symbol === symbol ? 1.0 : 0.8,
			});
		}
	}

	const coverage: ContextPackCoverage = {
		reachedSymbols: reached.length,
		returnedSymbols: finalSpans.length,
		omittedByBudget: Math.max(0, reached.length - finalSpans.length),
		unresolvedEdges: unresolved.size,
		lowConfidenceEdges: lowConfidence.size,
	};

	const rawWarnings: string[] = [];
	if (truncated && coverage.omittedByBudget > 0) {
		rawWarnings.push(
			`${coverage.omittedByBudget} span(s) omitted by token budget (max_tokens=${maxTokens}); spans are ordered target → depth → file → symbol, so the most relevant context was kept`,
		);
	}
	if (estimatedTokens > maxTokens) {
		rawWarnings.push(
			`returned pack exceeds max_tokens (${estimatedTokens} > ${maxTokens}); the target span is always included`,
		);
	}
	if (unresolved.size > 0) {
		rawWarnings.push(
			`${unresolved.size} symbol-edge destination(s) not present in the graph (unresolved)`,
		);
	}
	if (lowConfidence.size > 0) {
		rawWarnings.push(
			`${lowConfidence.size} symbol-edge destination(s) lack an export range (low confidence)`,
		);
	}
	rawWarnings.push(...boundedDetails(readFailures, 'source read failed'));
	rawWarnings.push(...boundedDetails(oversizedSources, 'source too large'));
	rawWarnings.push(
		...boundedDetails(outsideWorkspace, 'source outside workspace'),
	);
	const warnings = [...new Set(rawWarnings)];

	const result: ContextPackResult = {
		schemaSupported: true,
		target: { file: targetFile, symbol },
		spans: finalSpans,
		truncated,
		estimatedTokens,
		coverage,
		warnings,
	};

	if (includeSource) {
		result.sourceIncluded = true;
		result.snippets = snippets;
	}

	return result;
}

function collectExternallyUsedSymbols(
	graph: RepoGraph,
	node: GraphNode | undefined,
): string[] {
	if (!node) return [];
	const exported = new Set(node.exports);
	const used = new Set<string>();
	const targetKey = normalizeGraphPath(node.filePath);
	for (const edge of graph.edges) {
		if (isAssetEdge(edge)) continue;
		if (normalizeGraphPath(edge.target) !== targetKey) continue;
		for (const symbol of edge.importedSymbols ?? []) {
			if (exported.has(symbol)) used.add(symbol);
		}
	}
	return [...used].sort((a, b) => a.localeCompare(b));
}

function formatLocalizationSummary(opts: {
	target: string;
	importers: FileReference[];
	dependencies: FileReference[];
	blast: BlastRadiusResult;
	externalSymbols: string[];
	ontology: FileOntology | null;
	maxImporters: number;
	maxDeps: number;
}): string {
	const importerList =
		opts.importers.length === 0
			? '(none)'
			: opts.importers
					.slice(0, opts.maxImporters)
					.map((ref) => ref.file)
					.join(', ') +
				(opts.importers.length > opts.maxImporters
					? `, +${opts.importers.length - opts.maxImporters} more`
					: '');
	const depList =
		opts.dependencies.length === 0
			? '(none)'
			: opts.dependencies
					.slice(0, opts.maxDeps)
					.map((ref) => ref.file)
					.join(', ') +
				(opts.dependencies.length > opts.maxDeps
					? `, +${opts.dependencies.length - opts.maxDeps} more`
					: '');
	const symbolList =
		opts.externalSymbols.length === 0
			? '(none used externally)'
			: opts.externalSymbols.slice(0, 8).join(', ') +
				(opts.externalSymbols.length > 8
					? `, +${opts.externalSymbols.length - 8} more`
					: '');
	const roles = opts.ontology?.roles.join(', ') || 'unknown';
	const findings = opts.ontology?.findings.length ?? 0;
	return [
		'LOCALIZATION CONTEXT',
		`  Target: ${opts.target}`,
		`  Roles: ${roles}`,
		`  Imported by (${opts.importers.length}): ${importerList}`,
		`  Imports (${opts.dependencies.length}): ${depList}`,
		`  Exports used externally: ${symbolList}`,
		`  Blast radius: ${opts.blast.totalDependents} files (${opts.blast.riskLevel} risk)`,
		`  Ontology findings: ${findings}`,
	].join('\n');
}

export function getPackageBoundaries(
	graph: RepoGraph,
	topN = 25,
): PackageBoundarySummary[] {
	return summarizePackageBoundaries(
		Object.values(graph.nodes),
		graph.edges,
		topN,
	);
}

function summarizePackageBoundaries(
	nodes: GraphNode[],
	edges: GraphEdge[],
	topN: number,
): PackageBoundarySummary[] {
	const groups = new Map<string, PackageBoundarySummary>();
	const ensure = (node: GraphNode): PackageBoundarySummary => {
		const ontology = node.ontology;
		const name = ontology?.packageBoundary || inferBoundary(node.moduleName);
		let group = groups.get(name);
		if (!group) {
			group = {
				name,
				root: name,
				fileCount: 0,
				roles: {},
				dependsOn: [],
				dependedOnBy: [],
				routeCount: 0,
				dataOperationCount: 0,
				findingCount: 0,
				publicFiles: [],
			};
			groups.set(name, group);
		}
		return group;
	};

	const boundaryByPath = new Map<string, string>();
	for (const node of nodes) {
		const group = ensure(node);
		boundaryByPath.set(normalizeGraphPath(node.filePath), group.name);
		group.fileCount++;
		const ontology = node.ontology;
		for (const role of ontology?.roles ?? ['source_module']) {
			group.roles[role] = (group.roles[role] ?? 0) + 1;
		}
		group.routeCount += ontology?.routes.length ?? 0;
		group.dataOperationCount += ontology?.dataOperations.length ?? 0;
		group.findingCount += ontology?.findings.length ?? 0;
		if (node.exports.length > 0) {
			group.publicFiles.push(node.moduleName);
		}
	}

	const dependsOn = new Map<string, Set<string>>();
	const dependedOnBy = new Map<string, Set<string>>();
	for (const edge of edges) {
		// Asset edges do not represent a real package dependency (their target
		// is not a source file), so they are excluded from boundary graphs.
		if (isAssetEdge(edge)) continue;
		const sourceBoundary = boundaryByPath.get(normalizeGraphPath(edge.source));
		const targetBoundary = boundaryByPath.get(normalizeGraphPath(edge.target));
		if (
			!sourceBoundary ||
			!targetBoundary ||
			sourceBoundary === targetBoundary
		) {
			continue;
		}
		if (!dependsOn.has(sourceBoundary))
			dependsOn.set(sourceBoundary, new Set());
		if (!dependedOnBy.has(targetBoundary)) {
			dependedOnBy.set(targetBoundary, new Set());
		}
		dependsOn.get(sourceBoundary)?.add(targetBoundary);
		dependedOnBy.get(targetBoundary)?.add(sourceBoundary);
	}

	for (const group of groups.values()) {
		group.dependsOn = [...(dependsOn.get(group.name) ?? [])].sort();
		group.dependedOnBy = [...(dependedOnBy.get(group.name) ?? [])].sort();
		group.publicFiles.sort((a, b) => a.localeCompare(b));
		group.publicFiles = group.publicFiles.slice(0, 20);
	}

	return [...groups.values()]
		.sort((a, b) => {
			if (b.findingCount !== a.findingCount) {
				return b.findingCount - a.findingCount;
			}
			if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
			return a.name.localeCompare(b.name);
		})
		.slice(0, topN);
}

function summarizeSelectedPackageBoundaries(
	graph: RepoGraph,
	nodes: GraphNode[],
	topN = 25,
): PackageBoundarySummary[] {
	const summaries = summarizePackageBoundaries(nodes, [], topN);
	const boundaryByModule = new Map<string, string>();
	for (const node of nodes) {
		boundaryByModule.set(
			normalizeLookupPath(node.moduleName),
			node.ontology?.packageBoundary ?? inferBoundary(node.moduleName),
		);
	}
	const byName = new Map(summaries.map((summary) => [summary.name, summary]));
	const dependsOn = new Map<string, Set<string>>();
	const dependedOnBy = new Map<string, Set<string>>();
	for (const node of nodes) {
		const sourceBoundary = boundaryByModule.get(
			normalizeLookupPath(node.moduleName),
		);
		if (!sourceBoundary) continue;
		for (const dep of getDependencies(graph, node.moduleName)) {
			const targetBoundary = boundaryByModule.get(
				normalizeLookupPath(dep.file),
			);
			if (
				!targetBoundary ||
				sourceBoundary === targetBoundary ||
				!byName.has(sourceBoundary) ||
				!byName.has(targetBoundary)
			) {
				continue;
			}
			if (!dependsOn.has(sourceBoundary)) {
				dependsOn.set(sourceBoundary, new Set());
			}
			if (!dependedOnBy.has(targetBoundary)) {
				dependedOnBy.set(targetBoundary, new Set());
			}
			dependsOn.get(sourceBoundary)?.add(targetBoundary);
			dependedOnBy.get(targetBoundary)?.add(sourceBoundary);
		}
	}
	for (const summary of summaries) {
		summary.dependsOn = [...(dependsOn.get(summary.name) ?? [])].sort();
		summary.dependedOnBy = [...(dependedOnBy.get(summary.name) ?? [])].sort();
	}
	return summaries;
}

/**
 * No-ontology fallback for the package boundary. Delegates to the shared
 * `inferPackageBoundary` helper (no `hasManifest` callback here — the query
 * path does not retain the walk-time manifest set, so it falls back to the
 * static segment rules). Keeps the query fallback in lockstep with ontology
 * extraction (issue #1985, defect A8).
 */
function inferBoundary(moduleName: string): string {
	return inferPackageBoundary(moduleName);
}

export function buildOntologyPreflightPacket(
	graph: RepoGraph,
	filePaths: string[] = [],
	options: {
		maxFiles?: number;
		maxFindings?: number;
		maxBoundaries?: number;
	} = {},
): Record<string, unknown> {
	const maxFiles = options.maxFiles ?? 12;
	const maxFindings = options.maxFindings ?? 20;
	const selectedNodes =
		filePaths.length > 0
			? filePaths
					.map((filePath) => getGraphNode(graph, filePath))
					.filter((node): node is GraphNode => node !== undefined)
			: getKeyFiles(graph, maxFiles);
	const boundedNodes = selectedNodes.slice(0, maxFiles);
	const findings = boundedNodes
		.flatMap((node) =>
			(node.ontology?.findings ?? []).map((finding) => ({
				file: node.moduleName,
				...finding,
			})),
		)
		.slice(0, maxFindings);
	const routes = boundedNodes.flatMap((node) =>
		(node.ontology?.routes ?? []).map((route) => ({
			file: node.moduleName,
			...route,
		})),
	);
	const dataOperations = boundedNodes.flatMap((node) =>
		(node.ontology?.dataOperations ?? []).map((fact) => ({
			file: node.moduleName,
			...fact,
		})),
	);
	const security = boundedNodes.flatMap((node) =>
		(node.ontology?.security ?? []).map((fact) => ({
			file: node.moduleName,
			...fact,
		})),
	);

	return {
		generatedAt: new Date().toISOString(),
		targets: boundedNodes.map((node) => node.moduleName),
		summary: {
			fileCount: Object.keys(graph.nodes).length,
			edgeCount: graph.edges.length,
			targetCount: boundedNodes.length,
			findingCount: findings.length,
			routeCount: routes.length,
			dataOperationCount: dataOperations.length,
			securityFactCount: security.length,
		},
		files: boundedNodes.map((node) => ({
			file: node.moduleName,
			roles: node.ontology?.roles ?? [],
			packageBoundary:
				node.ontology?.packageBoundary ?? inferBoundary(node.moduleName),
			importerCount: getImporters(graph, node.moduleName).length,
			dependencyCount: getDependencies(graph, node.moduleName).length,
			routeCount: node.ontology?.routes.length ?? 0,
			dataOperationCount: node.ontology?.dataOperations.length ?? 0,
			securityFactCount: node.ontology?.security.length ?? 0,
			findingCount: node.ontology?.findings.length ?? 0,
		})),
		routes,
		dataOperations,
		security,
		findings,
		packageBoundaries: summarizeSelectedPackageBoundaries(
			graph,
			boundedNodes,
			options.maxBoundaries ?? 10,
		),
	};
}
