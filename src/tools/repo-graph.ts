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

export { _internals as _askInternals, askGraph } from './repo-graph/ask';
export type {
	RepoGraphInputMetadata,
	RepoGraphInputWalkOptions,
	RepoGraphInputWalkResult,
	ScanResult,
} from './repo-graph/builder';
export {
	addEdge,
	buildWorkspaceGraph,
	buildWorkspaceGraphAsync,
	isGraphWideInputPath,
	isScannableSourcePath,
	resolveModuleSpecifier,
	upsertNode,
	walkRepoGraphInputs,
} from './repo-graph/builder';
export {
	clearCache,
	getCachedGraph,
	getCachedMtime,
	isDirty,
	markDirty,
	setCachedGraph,
} from './repo-graph/cache';
export type {
	FreshnessOptions,
	FreshnessProbe,
} from './repo-graph/freshness';
export {
	EXTRACTOR_STAMP,
	FINGERPRINT_SCHEMA_VERSION,
	invalidateFreshnessCache,
	probeFreshness,
	REPO_GRAPH_FINGERPRINT_FILENAME,
	writeFingerprint,
} from './repo-graph/freshness';
export { updateGraphForFiles } from './repo-graph/incremental';
export type { ExtractFileOntologyInput } from './repo-graph/ontology';
export { extractFileOntology } from './repo-graph/ontology';
export type { DeadExportsOptions } from './repo-graph/query';
export {
	buildOntologyPreflightPacket,
	getBlastRadius,
	getCallers,
	getContextPack,
	getDeadExports,
	getDependencies,
	getFileOntology,
	getGraphHealth,
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
	AskHit,
	AskOptions,
	AskResult,
	BlastRadiusResult,
	BuildWorkspaceGraphOptions,
	CallerReference,
	ContextPackResult,
	ContextPackSpan,
	ConventionFact,
	DataOperationFact,
	DeadExportCandidate,
	DeadExportsResult,
	FileOntology,
	FileReference,
	FileRole,
	FreshnessProbeState,
	GraphEdge,
	GraphExtractionFailure,
	GraphExtractorInputWitness,
	GraphHealthResult,
	GraphNode,
	GraphUnresolvedImport,
	LocalizationBlock,
	OntologyFinding,
	PackageBoundarySummary,
	RepoGraph,
	RepoGraphDiagnostics,
	RouteFact,
	RouteMethod,
	SecurityFact,
	SymbolEdge,
	SymbolEdgeEvidence,
	SymbolEdgeKind,
	SymbolEdgeResolution,
	SymbolIdentityKind,
	SymbolReference,
} from './repo-graph/types';
export {
	createEmptyGraph,
	GRAPH_SCHEMA_VERSION,
	inferPackageBoundary,
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
