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
 *   symbol-query.ts — KG-14 symbol/impact/diff/explain queries (issue #1535)
 *   pack-query.ts  — KG-15 route/data/test change-risk packs (issue #1536)
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
export {
	extractFileOntology,
	normalizeRoutePathInput,
} from './repo-graph/ontology';
export { buildTestPack, traceData, traceRoute } from './repo-graph/pack-query';
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
export type {
	LexicalResult,
	RetrievalMode,
	RetrievalRequest,
	RetrievalResult,
} from './repo-graph/retrieval-router';
export {
	classifyRetrieval,
	RETRIEVAL_MODES,
	ROUTER_METADATA_OVERHEAD_TOKENS,
	routeRetrieval,
} from './repo-graph/retrieval-router';
export {
	getGraphPath,
	loadGraph,
	loadGraphSync,
	loadOrCreateGraph,
	saveGraph,
	saveIfDirty,
} from './repo-graph/storage';
export {
	explainGraphEntry,
	getDiffContext,
	getImpactCone,
	getSymbolContext,
	searchSymbols,
} from './repo-graph/symbol-query';
export type {
	AskHit,
	AskOptions,
	AskResult,
	BlastRadiusResult,
	BuildWorkspaceGraphOptions,
	CallerReference,
	ConeEntry,
	ContextPackCoverage,
	ContextPackResult,
	ContextPackSnippet,
	ContextPackSourceMode,
	ContextPackSpan,
	ConventionFact,
	DataOperationFact,
	DataTraceAccess,
	DataTraceResult,
	DeadExportCandidate,
	DeadExportsResult,
	DerivedAssociation,
	DiffContextResult,
	DiffFileSummary,
	DiffSymbolChange,
	ExplainReason,
	FileOntology,
	FileReference,
	FileRole,
	FreshnessProbeState,
	GraphEdge,
	GraphExplainResult,
	GraphExtractionFailure,
	GraphExtractorInputWitness,
	GraphHealthResult,
	GraphNode,
	GraphSymbolKind,
	GraphSymbolVisibility,
	GraphUnresolvedImport,
	ImpactConeResult,
	LocalizationBlock,
	OntologyFinding,
	OntologyLink,
	OntologyLinkConfidence,
	OntologyLinkKind,
	PackageBoundarySummary,
	RepoGraph,
	RepoGraphDiagnostics,
	RouteFact,
	RouteMethod,
	RouteTraceResult,
	RouteTraceRoute,
	SecurityFact,
	SymbolContextResult,
	SymbolEdge,
	SymbolEdgeEvidence,
	SymbolEdgeKind,
	SymbolEdgeResolution,
	SymbolHit,
	SymbolIdentityKind,
	SymbolReference,
	SymbolSearchResult,
	TestPackFixture,
	TestPackResult,
	TestPackTestEntry,
} from './repo-graph/types';
export {
	createEmptyGraph,
	DEFAULT_MAX_SOURCE_BYTES,
	GRAPH_SCHEMA_VERSION,
	inferPackageBoundary,
	isSchemaVersionAtLeast,
	normalizeGraphPath,
	ONTOLOGY_LINK_CONFIDENCE_VALUES,
	ONTOLOGY_LINK_KIND_VALUES,
	REPO_GRAPH_FILENAME,
	updateGraphMetadata,
} from './repo-graph/types';
export {
	validateGraphEdge,
	validateGraphNode,
	validateWorkspace,
} from './repo-graph/validation';
