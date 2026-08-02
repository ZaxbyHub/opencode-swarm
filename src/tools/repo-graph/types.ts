/**
 * Types and core utilities for the repo dependency graph.
 *
 * This module is the dependency-free foundation: it contains only type
 * definitions, schema constants, the normalizeGraphPath utility, and
 * basic graph construction helpers that have no further internal dependencies.
 * Every other submodule imports from here.
 */

import * as path from 'node:path';

// ============ Constants ============

export const REPO_GRAPH_FILENAME = 'repo-graph.json';
/**
 * Graph schema version.
 *
 * 1.1.0 added per-edge `usedSymbols` (imported symbols actually referenced in
 * the importing file) and per-node `exportLines`, enabling the `callers` and
 * `dead_exports` queries. Both fields are optional, so graphs written by older
 * versions (1.0.0) still load — but `dead_exports` requires >= 1.1.0 data and
 * self-gates via {@link isSchemaVersionAtLeast} rather than relying on the
 * loader (which only checks that a version string is present, not its value).
 *
 * 1.2.0 adds per-node `exportRanges` (1-based inclusive line spans for each
 * exported symbol) and the top-level `symbolEdges` array (direct symbol-to-
 * symbol reference edges). Both fields are optional, so 1.0.0 and 1.1.0 graphs
 * still load without corruption. New queries may use these fields to provide
 * more precise context-packing and symbol-level navigation.
 *
 * 1.3.0 adds the optional per-edge `targetKind` field (`'node' | 'asset'`)
 * that distinguishes edges whose resolved target is a scannable source file
 * (a graph node) from edges whose target is an asset (JSON/CSS/etc. — a real
 * file that never becomes a node). The field is optional, so 1.0.0–1.2.0
 * graphs still load; `storage.ts` only checks that a version string is
 * present, and feature gating is per-query via {@link isSchemaVersionAtLeast}.
 * For pre-1.3.0 graphs the loader/queries fall back to an extension check
 * (`isScannableSourcePath`) to classify an untagged edge's target kind.
 *
 * Diagnostics are additive and optional on all schema versions. Old graphs
 * without diagnostics remain readable; graph-health queries surface empty
 * diagnostics with an explicit rebuild note.
 */
export const GRAPH_SCHEMA_VERSION = '1.3.0';

/**
 * Compare dotted numeric version strings (e.g. '1.1.0' >= '1.1.0').
 * Missing/non-numeric segments are treated as 0. Returns true when `version`
 * is greater than or equal to `minimum`.
 */
export function isSchemaVersionAtLeast(
	version: string | undefined,
	minimum: string,
): boolean {
	const parse = (v: string): number[] =>
		v.split('.').map((part) => {
			const n = Number.parseInt(part, 10);
			return Number.isFinite(n) ? n : 0;
		});
	const a = parse(version ?? '');
	const b = parse(minimum);
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		if (av > bv) return true;
		if (av < bv) return false;
	}
	return true;
}

// ============ Types ============

export const FILE_ROLE_VALUES = [
	'api_route',
	'middleware',
	'service_module',
	'data_module',
	'swarm_tool',
	'agent',
	'hook',
	'config',
	'schema',
	'test_file',
	'cli_command',
	'documentation',
	'source_module',
] as const;
export type FileRole = (typeof FILE_ROLE_VALUES)[number];

export const ROUTE_METHOD_VALUES = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
	'OPTIONS',
	'HEAD',
	'ALL',
] as const;
export type RouteMethod = (typeof ROUTE_METHOD_VALUES)[number];

export const ROUTE_SOURCE_VALUES = [
	'file_path',
	'handler_export',
	'router_call',
] as const;
export type RouteSource = (typeof ROUTE_SOURCE_VALUES)[number];

export interface RouteFact {
	method: RouteMethod;
	path: string;
	line?: number;
	source: RouteSource;
}

export const DATA_OPERATION_VALUES = [
	'read',
	'write',
	'delete',
	'transaction',
	'migration',
] as const;
export type DataOperation = (typeof DATA_OPERATION_VALUES)[number];

export const DATA_ACCESS_VALUES = [
	'database',
	'orm',
	'sql',
	'filesystem',
	'network',
	'unknown',
] as const;
export type DataAccess = (typeof DATA_ACCESS_VALUES)[number];

export interface DataOperationFact {
	operation: DataOperation;
	access: DataAccess;
	entity?: string;
	line: number;
	evidence: string;
}

export const SECURITY_KIND_VALUES = [
	'authentication',
	'authorization',
	'input_validation',
	'csrf',
	'sanitization',
	'secret_handling',
] as const;
export type SecurityKind = (typeof SECURITY_KIND_VALUES)[number];

export const SECURITY_CONFIDENCE_VALUES = ['low', 'medium', 'high'] as const;
export type SecurityConfidence = (typeof SECURITY_CONFIDENCE_VALUES)[number];

export interface SecurityFact {
	kind: SecurityKind;
	line: number;
	evidence: string;
	confidence: SecurityConfidence;
}

export interface ConventionFact {
	name: string;
	line?: number;
	evidence: string;
}

export const ONTOLOGY_FINDING_SEVERITY_VALUES = [
	'info',
	'low',
	'medium',
	'high',
] as const;
export type OntologyFindingSeverity =
	(typeof ONTOLOGY_FINDING_SEVERITY_VALUES)[number];

export interface OntologyFinding {
	code: string;
	severity: OntologyFindingSeverity;
	message: string;
	line?: number;
}

export interface FileOntology {
	roles: FileRole[];
	packageBoundary: string;
	routes: RouteFact[];
	dataOperations: DataOperationFact[];
	security: SecurityFact[];
	conventions: ConventionFact[];
	findings: OntologyFinding[];
}

/**
 * A node in the dependency graph representing a source file.
 */
export interface GraphNode {
	/** Resolved absolute path to the source file */
	filePath: string;
	/** Normalized module name (relative path from workspace root) */
	moduleName: string;
	/** Exported symbols from this file */
	exports: string[];
	/**
	 * Definition line for each exported symbol, keyed by symbol name (1-based).
	 * Optional and best-effort: present on graphs built at schema >= 1.1.0,
	 * absent for symbols whose line could not be determined. Used to point
	 * `dead_exports` candidates at a location.
	 */
	exportLines?: Record<string, number>;
	/**
	 * 1-based inclusive line span for each exported symbol, keyed by symbol
	 * name. Present on graphs built at schema >= 1.2.0; absent on older
	 * graphs. Used for precise context-packing around a symbol.
	 * Each span value uses `startLine` / `endLine` to match the codebase
	 * convention (see `ContextPackSpan` and `FileSymbolFacts`).
	 */
	exportRanges?: Record<string, { startLine: number; endLine: number }>;
	/** Imported module specifiers */
	imports: string[];
	/** Language/extension of the file */
	language: string;
	/** Last modified timestamp */
	mtime: string;
	/** Optional code ontology facts for agent context/preflight packets */
	ontology?: FileOntology;
}

export const IMPORT_TYPE_VALUES = [
	'default',
	'named',
	'namespace',
	'require',
	'sideeffect',
	'type',
] as const;
export type ImportType = (typeof IMPORT_TYPE_VALUES)[number];

/**
 * An edge in the dependency graph representing a dependency relationship.
 */
export interface GraphEdge {
	/** Source file path */
	source: string;
	/** Target file path (resolved) */
	target: string;
	/** Import specifier used */
	importSpecifier: string;
	/** Type of import */
	importType: ImportType;
	/** Named symbols imported from the target, when statically detectable */
	importedSymbols?: string[];
	/**
	 * The subset of the target's exported symbols (by their *exported* name)
	 * that are actually referenced in the source file's body — not merely
	 * imported. Computed at build time via a conservative, alias-aware textual
	 * scan (schema >= 1.1.0). Absent on namespace/side-effect/require/dynamic
	 * imports, where individual symbol usage is not statically resolvable.
	 */
	usedSymbols?: string[];
	/**
	 * Whether the resolved target is a graph node or an asset. `'node'` targets
	 * are scannable source files that become graph nodes; `'asset'` targets are
	 * real files (JSON/CSS/etc.) that never become nodes (schema >= 1.3.0).
	 * Absent on older graphs — callers fall back to `isScannableSourcePath` on
	 * the target path. Asset edges only require their source node to exist
	 * during incremental validation, and are excluded from in-degree ranking /
	 * importer / dependent queries.
	 */
	targetKind?: 'node' | 'asset';
}

export interface FileReference {
	file: string;
	line?: number;
	importType?: GraphEdge['importType'];
}

export interface SymbolReference {
	file: string;
	line?: number;
	importedAs: string;
}

/**
 * A symbol-level reference edge: one exported symbol in one file directly
 * references (calls / uses) an exported symbol in another file.
 *
 * Present in graphs built at schema >= 1.2.0. These edges are finer-grained
 * than {@link GraphEdge} (which tracks file-level imports) and enable
 * precise context-packing and symbol navigation queries.
 */
export interface SymbolEdge {
	/** Resolved absolute path of the source file (matches `GraphNode.filePath` keys). */
	fromFile: string;
	/** Enclosing top-level declaration in the source file, or `'<module>'` for module-scope references. */
	fromSymbol: string;
	/** Resolved absolute path of the target file. */
	toFile: string;
	/** Exported symbol referenced in the target file. */
	toSymbol: string;
}

/**
 * A contiguous line span inside a source file, used by context-packing to
 * extract the relevant region around a symbol without reading the whole file.
 */
export interface ContextPackSpan {
	file: string;
	symbol: string;
	startLine: number;
	endLine: number;
	mode: 'full' | 'signature';
}

/**
 * Result of a context-pack query: the set of spans needed to understand
 * how a target symbol is used across the workspace.
 */
export interface ContextPackResult {
	/** False when the graph predates schema 1.2.0 (rebuild required for full results). */
	schemaSupported: boolean;
	/** The symbol whose usage context was requested. */
	target: { file: string; symbol: string };
	/** Deduped, budget-ordered spans covering usage sites. */
	spans: ContextPackSpan[];
	/** True when the span budget was exhausted before all sites could be returned. */
	truncated: boolean;
	/** Rough token estimate for the returned spans (sum of span sizes × a fixed multiplier). */
	estimatedTokens: number;
	/** Optional human-readable note about scope or limitations. */
	note?: string;
}

/**
 * A file that references a specific exported symbol of a target file.
 * `resolution` records how confidently the usage was attributed:
 *   - 'used'     → the symbol was found referenced in the source body
 *   - 'imported' → fallback for graphs predating usedSymbols (schema < 1.1.0);
 *                  the symbol is imported but body usage was not analyzed
 */
export interface CallerReference {
	file: string;
	resolution: 'used' | 'imported';
}

/**
 * An exported symbol with no detected in-repo reference. Advisory only —
 * regex-based analysis cannot see dynamic dispatch, string-keyed access, or
 * usage through namespace/barrel re-exports, so this is a *candidate* for
 * review, never a directive to delete.
 */
export interface DeadExportCandidate {
	/** Module name (workspace-relative) of the file that owns the export */
	file: string;
	/** The exported symbol name */
	symbol: string;
	/** Definition line, when known (from exportLines) */
	line?: number;
	/** How many other in-repo files import this file at all */
	importerCount: number;
}

export interface DeadExportsResult {
	/** False when the graph predates schema 1.1.0 (rebuild required). */
	schemaSupported: boolean;
	/** Files whose exports were analyzed (imported by >= 1 other file). */
	analyzedFiles: number;
	/**
	 * Files skipped because at least one importer used a namespace/side-effect/
	 * require/dynamic import, making per-symbol usage unresolvable.
	 */
	skippedUnresolvable: number;
	candidates: DeadExportCandidate[];
	/** Human-readable note describing scope and limitations of the result. */
	note: string;
}

export interface GraphExtractionFailure {
	file: string;
	language: string;
	reason: string;
}

export interface GraphUnresolvedImport {
	file: string;
	specifier: string;
}

export interface RepoGraphDiagnostics {
	extractionFailures?: GraphExtractionFailure[];
	unresolvedImports?: GraphUnresolvedImport[];
	oversizedFiles?: string[];
	unsupportedFiles?: string[];
	binaryFiles?: string[];
	unreadableFiles?: string[];
	lowConfidenceEdgeCount?: number;
	/**
	 * True when the last workspace walk was truncated by the file cap or wall-
	 * clock budget (issue #1985, defect A7). Additive/optional on all schema
	 * versions — old graphs without it read as `false`.
	 */
	walkTruncated?: boolean;
	/** Why the walk truncated: hit the wall-clock `'budget'` or the `'cap'`. */
	walkTruncationReason?: 'budget' | 'cap';
	/**
	 * Count of incremental-update passes that fell back to a full rebuild
	 * (issue #1985, defect A1). Accumulated across incremental runs; reset on
	 * a fresh full build.
	 */
	incrementalFallbacks?: number;
}

export interface GraphHealthResult {
	schemaVersion: string | null;
	fresh: boolean;
	staleFiles: string[];
	extractionFailures: GraphExtractionFailure[];
	unresolvedImports: GraphUnresolvedImport[];
	oversizedFiles: string[];
	unsupportedFiles: string[];
	binaryFiles: string[];
	unreadableFiles: string[];
	lowConfidenceEdgeCount: number;
	walkTruncated: boolean;
	walkTruncationReason: 'budget' | 'cap' | null;
	incrementalFallbacks: number;
	notes: string[];
}

export interface BlastRadiusResult {
	target: string[];
	directDependents: string[];
	transitiveDependents: string[];
	depthReached: number;
	totalDependents: number;
	riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface LocalizationBlock {
	target: string;
	importerCount: number;
	importers: FileReference[];
	dependencyCount: number;
	dependencies: FileReference[];
	exportedSymbolsUsedExternally: string[];
	blastRadius: BlastRadiusResult;
	summary: string;
}

export interface PackageBoundarySummary {
	name: string;
	root: string;
	fileCount: number;
	roles: Partial<Record<FileRole, number>>;
	dependsOn: string[];
	dependedOnBy: string[];
	routeCount: number;
	dataOperationCount: number;
	findingCount: number;
	publicFiles: string[];
}

/**
 * The complete dependency graph for a workspace.
 */
export interface RepoGraph {
	/** Schema version for future compatibility */
	schema_version: string;
	/** Workspace root directory */
	workspaceRoot: string;
	/** Graph nodes keyed by resolved file path */
	nodes: Record<string, GraphNode>;
	/** Graph edges representing dependencies */
	edges: GraphEdge[];
	/** Graph metadata */
	metadata: {
		generatedAt: string;
		generator: string;
		nodeCount: number;
		edgeCount: number;
	};
	/** Symbol-level reference edges (schema >= 1.2.0; absent on older graphs). */
	symbolEdges?: SymbolEdge[];
	/** Optional bounded diagnostics from the last graph build. */
	diagnostics?: RepoGraphDiagnostics;
}

/**
 * Options for building a workspace graph.
 */
export interface BuildWorkspaceGraphOptions {
	maxFileSizeBytes?: number;
	maxFiles?: number;
	walkBudgetMs?: number;
	followSymlinks?: boolean;
	/**
	 * Extra directory basenames to skip during the workspace walk, merged with
	 * the built-in `SKIP_DIRECTORIES` defaults (issue #1448). Matched by basename
	 * at any depth, not as glob/path patterns.
	 */
	excludeDirs?: readonly string[];
}

// ============ Utilities ============

/**
 * Normalize a file path for use as a graph key.
 * Uses path.normalize for segment cleanup, then converts all
 * backslashes to forward slashes for cross-platform consistency.
 * This ensures the same file produces the same key on Windows, macOS, and Linux.
 */
export function normalizeGraphPath(filePath: string): string {
	return path.normalize(filePath).replace(/\\/g, '/');
}

/**
 * Top-level directory segments that, when present as the first path segment,
 * mark the next segment as a package boundary (monorepo workspaces). Used by
 * {@link inferPackageBoundary} (issue #1985, defect A8).
 */
const PACKAGE_BOUNDARY_ROOTS = new Set([
	'packages',
	'crates',
	'apps',
	'libs',
	'services',
]);

/**
 * Infer the package boundary for a module name using the generic rule shared
 * by ontology extraction and the query-side no-ontology fallback (issue #1985,
 * defect A8). Pure / dependency-free / no fs I/O so it can live in this
 * foundation module and stay callable from both `ontology.ts` and `query.ts`.
 *
 * Rules (in order):
 *  - empty → `'.'`
 *  - segment 0 ∈ {packages, crates, apps, libs, services} with ≥2 segments → `<seg0>/<seg1>`
 *  - segment 0 === `src` with ≥2 segments → `src/<seg1>`
 *  - segment 0 === `tests` with ≥2 segments → `tests/<seg1>`
 *  - when `hasManifest` is provided and either `<seg0>` or `<seg0>/<seg1>` is a
 *    manifest-bearing directory (with ≥2 segments) → `<seg0>/<seg1>`
 *  - otherwise → segment 0 (or `'.'` when there are no segments)
 *
 * The previous `src/tools/repo-graph` special case is intentionally removed:
 * user repos should not inherit this project's internal layout.
 *
 * @param moduleName - Workspace-relative module name (forward slashes).
 * @param hasManifest - Optional callback returning true when a workspace-
 *   relative directory contains a package manifest (`package.json`,
 *   `Cargo.toml`, `pyproject.toml`, `go.mod`). When omitted, only the static
 *   segment rules apply.
 */
export function inferPackageBoundary(
	moduleName: string,
	hasManifest?: (relDir: string) => boolean,
): string {
	const normalized = moduleName.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length === 0) return '.';
	if (PACKAGE_BOUNDARY_ROOTS.has(parts[0]) && parts.length >= 2) {
		return `${parts[0]}/${parts[1]}`;
	}
	if (parts[0] === 'src' && parts.length >= 2) {
		return `src/${parts[1]}`;
	}
	if (parts[0] === 'tests' && parts.length >= 2) {
		return `tests/${parts[1]}`;
	}
	if (hasManifest && parts.length >= 2) {
		// A manifest directly under seg0 (e.g. `<seg0>/package.json`) marks the
		// whole subtree as one package root; a manifest under seg0/seg1 marks
		// that subdirectory as its own package.
		if (hasManifest(parts[0]) || hasManifest(`${parts[0]}/${parts[1]}`)) {
			return `${parts[0]}/${parts[1]}`;
		}
	}
	return parts[0];
}

// ============ Basic Graph Construction ============

/**
 * Create an empty graph for a workspace.
 * @param workspaceRoot - The workspace root directory
 * @returns Empty RepoGraph structure
 */
export function createEmptyGraph(workspaceRoot: string): RepoGraph {
	return {
		schema_version: GRAPH_SCHEMA_VERSION,
		workspaceRoot: path.normalize(workspaceRoot),
		nodes: {},
		edges: [],
		metadata: {
			generatedAt: new Date().toISOString(),
			generator: 'repo-graph',
			nodeCount: 0,
			edgeCount: 0,
		},
	};
}

/**
 * Update graph metadata after modifications.
 * @param graph - The graph to update
 */
export function updateGraphMetadata(graph: RepoGraph): void {
	graph.metadata = {
		generatedAt: new Date().toISOString(),
		generator: 'repo-graph',
		nodeCount: Object.keys(graph.nodes).length,
		edgeCount: graph.edges.length,
	};
}
