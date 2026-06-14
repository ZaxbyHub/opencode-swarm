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
export const GRAPH_SCHEMA_VERSION = '1.0.0';

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
