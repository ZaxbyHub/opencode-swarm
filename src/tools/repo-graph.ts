/**
 * Repo graph module — public API barrel.
 *
 * This file re-exports the complete public API of the repo graph system.
 * The implementation has been split into focused submodules under
 * src/tools/repo-graph/ for maintainability:
 *
 *   types.ts       — types/interfaces, constants, and basic graph helpers
 *   validation.ts  — path/node/edge validation functions
 *   cache.ts       — in-memory graph cache operations
 *   storage.ts     — safe load and save to .swarm/repo-graph.json
 *   builder.ts     — workspace scanning and full-graph construction
 *   incremental.ts — incremental updates for changed files
 *
 * All existing imports of this module continue to work unchanged.
 */

export type { ScanResult } from './repo-graph/builder';
export {
	addEdge,
	buildWorkspaceGraph,
	buildWorkspaceGraphAsync,
	resolveModuleSpecifier,
	upsertNode,
} from './repo-graph/builder';
export {
	clearCache,
	getCachedGraph,
	getCachedMtime,
	isDirty,
	markDirty,
	setCachedGraph,
} from './repo-graph/cache';
export { updateGraphForFiles } from './repo-graph/incremental';
export type { ExtractFileOntologyInput } from './repo-graph/ontology';
export { extractFileOntology } from './repo-graph/ontology';
export type { DeadExportsOptions } from './repo-graph/query';
export {
	buildOntologyPreflightPacket,
	getBlastRadius,
	getCallers,
	getDeadExports,
	getDependencies,
	getFileOntology,
	getGraphNode,
	getImporters,
	getKeyFiles,
	getLocalizationContext,
	getPackageBoundaries,
	getSymbolConsumers,
	isGraphFresh,
	resetQueryCache,
} from './repo-graph/query';
export {
	getGraphPath,
	loadGraph,
	loadGraphSync,
	loadOrCreateGraph,
	saveGraph,
	saveIfDirty,
} from './repo-graph/storage';
export type {
	BlastRadiusResult,
	BuildWorkspaceGraphOptions,
	CallerReference,
	ConventionFact,
	DataOperationFact,
	DeadExportCandidate,
	DeadExportsResult,
	FileOntology,
	FileReference,
	FileRole,
	GraphEdge,
	GraphNode,
	LocalizationBlock,
	OntologyFinding,
	PackageBoundarySummary,
	RepoGraph,
	RouteFact,
	RouteMethod,
	SecurityFact,
	SymbolReference,
} from './repo-graph/types';
export {
	createEmptyGraph,
	GRAPH_SCHEMA_VERSION,
	isSchemaVersionAtLeast,
	normalizeGraphPath,
	REPO_GRAPH_FILENAME,
	updateGraphMetadata,
} from './repo-graph/types';
export {
	validateGraphEdge,
	validateGraphNode,
	validateWorkspace,
} from './repo-graph/validation';
