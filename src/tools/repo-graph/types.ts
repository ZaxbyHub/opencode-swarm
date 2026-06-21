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
 */
export const GRAPH_SCHEMA_VERSION = '1.1.0';

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
