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
 * 1.2.0 adds per-node `exportRanges` (1-based inclusive line spans keyed by
 * symbol name — exported symbols for every grammar, plus non-exported member
 * defs for java/kotlin/csharp/cpp/swift; see the field docs) and the top-level
 * `symbolEdges` array (direct symbol-to-
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
 *
 * 1.4.0 adds optional numeric `sizeBytes` and `mtimeMs` witnesses to each
 * node. Builders capture them from the same stat used immediately before the
 * source read. The content-freshness sidecar requires both witnesses before
 * it will certify a graph; older graphs remain readable but are intentionally
 * treated as needing a rebuild before certification.
 *
 * 1.5.0 adds an optional graph-level `repoRootId` plus additive SymbolEdge v2
 * identity, kind, confidence, resolution, and evidence fields. Legacy 1.2.0
 * four-coordinate symbol edges remain readable and are normalized in memory.
 *
 * 1.6.0 adds the optional per-node `exportKinds` map (declaration kind per
 * symbol, keyed exactly like `exportRanges`), powering the KG-14 declaration-
 * kind query axis (`symbol_search` kind filter, `symbol_context` identity).
 * The field is optional, so 1.0.0–1.5.0 graphs still load; queries surface
 * `kind: null` hits and a `kindSupported: false` degradation note instead of
 * failing (issue #1535).
 */
export const GRAPH_SCHEMA_VERSION = '1.6.0';

/**
 * Default per-file source-size ceiling shared by graph construction and
 * query-time source reads. The builder treats this as the default value of
 * its `maxFileSizeBytes` option (which may be raised per build);
 * `getContextPack` always enforces this constant at read time regardless of
 * any build-time override, so a file built into the graph above this size
 * yields a `source too large` span instead of source text.
 */
export const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;

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
	 * 1-based inclusive line span per symbol, keyed by symbol name. Present on
	 * graphs built at schema >= 1.2.0; absent on older graphs. Used for precise
	 * context-packing around a symbol.
	 * Each span value uses `startLine` / `endLine` to match the codebase
	 * convention (see `ContextPackSpan` and `FileSymbolFacts`).
	 *
	 * SCOPE (issues #1529 and #1530): exported symbols for every grammar,
	 * PLUS non-exported member defs for java/kotlin/csharp/cpp/swift. A
	 * JVM/.NET or native-language member (or a Swift extension block) is
	 * deliberately never a file-level export, so without that widening
	 * `context_pack` could return no span at all for a Java method or a
	 * private C++ helper.
	 * `exports` and `exportLines` stay exported-only in every language.
	 *
	 * Duplicate names resolve so this map cannot disagree with `exportLines`:
	 * an exported def outranks a non-exported one; two exported defs take the
	 * last (as `exportLines` does); two non-exported defs take the first, and
	 * never appear in `exportLines` at all.
	 */
	exportRanges?: Record<string, { startLine: number; endLine: number }>;
	/**
	 * Declaration kind per symbol, keyed by symbol name (schema >= 1.6.0;
	 * optional, so older graphs load unchanged). Keys are assigned in the same
	 * builder loop and under the same widening + duplicate-name policies as
	 * `exportRanges`, but ONLY at real declaration sites — re-export bindings
	 * add an `exportRanges` entry without a kind (the symbol is declared
	 * elsewhere), so `exportKinds` is a subset of `exportRanges` keys.
	 * Absent entries read as `kind: null` (old graph, regex-fallback scan, or
	 * re-exported binding).
	 */
	exportKinds?: Record<string, GraphSymbolKind>;
	/** Imported module specifiers */
	imports: string[];
	/** Language/extension of the file */
	language: string;
	/** Last modified timestamp */
	mtime: string;
	/** Exact byte size captured by the stat that preceded the source read. */
	sizeBytes?: number;
	/** Numeric mtime captured with `sizeBytes`; avoids ISO precision loss. */
	mtimeMs?: number;
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
	 * real files that never become nodes (schema >= 1.3.0).
	 *
	 * `'asset'` covers TWO cases, and the second is easy to miss:
	 * 1. a non-source file (JSON/CSS/etc.), which was never scannable; and
	 * 2. a file that IS scannable but the walker never indexed — it sits under a
	 *    `SKIP_DIRECTORIES` entry (`node_modules`, `dist`, `vendor`, …) or behind
	 *    an unfollowed symlink. Import resolution does not consult those rules,
	 *    so it can resolve a real `.ts`/`.java` file the graph has no node for.
	 *    Such edges are demoted to `'asset'` at graph assembly (see
	 *    `reconcileEdgeTargetKinds`) so that `'node'` always means "a node exists
	 *    for this target". The demotion is language-agnostic: it applies to any
	 *    source file the walker skipped, not only to JVM/.NET ones.
	 *
	 * Consequence for consumers: `targetKind: 'asset'` no longer implies "not
	 * source code". Use `isScannableSourcePath(edge.target)` if that is what you
	 * actually need to know.
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
export const SYMBOL_EDGE_KIND_VALUES = [
	'CALLS',
	'REFERENCES',
	'USES_TYPE',
	'INSTANTIATES',
	'IMPLEMENTS',
	'OVERRIDES',
] as const;
export type SymbolEdgeKind = (typeof SYMBOL_EDGE_KIND_VALUES)[number];

export const SYMBOL_EDGE_RESOLUTION_VALUES = [
	'exact',
	'import_binding',
	'same_file_scope',
	'unique_name',
	'type_resolved',
	'lsp',
	'scip',
	'heuristic',
	'unresolved',
] as const;
export type SymbolEdgeResolution =
	(typeof SYMBOL_EDGE_RESOLUTION_VALUES)[number];

export type SymbolIdentityKind = 'symbol' | 'module';

/**
 * Declaration kind of a symbol — WHAT the symbol is (function, class, …).
 * Mirrors `FileSymbolFacts['defs'][number]['kind']` from
 * `src/lang/symbol-graph.ts` and is persisted per node via
 * `GraphNode.exportKinds` (schema >= 1.6.0).
 *
 * This is the DECLARATION axis and is deliberately distinct from
 * {@link SymbolEdgeKind}, the RELATIONSHIP axis (CALLS/REFERENCES/…) that
 * describes how two symbols connect. A symbol never referenced cross-file has
 * no symbol edge but still has a declaration kind.
 */
export const GRAPH_SYMBOL_KIND_VALUES = [
	'function',
	'class',
	'const',
	'type',
	'interface',
	'enum',
	'method',
] as const;
export type GraphSymbolKind = (typeof GRAPH_SYMBOL_KIND_VALUES)[number];

/**
 * Visibility tier derived at query time from persisted fields: a symbol in
 * `GraphNode.exports` is `exported` (public module surface); a symbol that
 * only exists in `exportRanges` (widened-grammar member defs) is
 * `module-local`.
 */
export type GraphSymbolVisibility = 'exported' | 'module-local';

export interface SymbolEdgeEvidence {
	/** Workspace-relative source path; source text itself is never persisted. */
	file: string;
	/** 1-based source line. */
	line: number;
	/** Optional 1-based source column. */
	column?: number;
	/** SHA-256 of the NFC-normalized logical source line. */
	snippetHash: string;
	/** Extractor that produced the fact, for example `tree-sitter/typescript`. */
	extractor: string;
}

export interface SymbolEdge {
	/** Resolved absolute path of the source file (matches `GraphNode.filePath` keys). */
	fromFile: string;
	/** Enclosing top-level declaration in the source file, or `'<module>'` for module-scope references. */
	fromSymbol: string;
	/** Resolved absolute path of the target file. */
	toFile: string;
	/** Exported symbol referenced in the target file. */
	toSymbol: string;
	/** Stable SHA-256 identity of this edge (schema >= 1.5.0). */
	id?: string;
	/** Stable SHA-256 identity of the source symbol. */
	fromId?: string;
	/** Stable SHA-256 identity of the target symbol. */
	toId?: string;
	/** Relationship kind. Current tree-sitter extraction emits REFERENCES. */
	kind?: SymbolEdgeKind;
	/** Advisory confidence in the inclusive range 0..1. */
	confidence?: number;
	/** How the relationship was resolved. */
	resolution?: SymbolEdgeResolution;
	/** Bounded provenance records. Empty only when no honest location exists. */
	evidence?: SymbolEdgeEvidence[];
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
	text?: string;
	note?: string;
}

/**
 * Source-text extraction mode for source-bearing context packs (issue #1533).
 * `include_source` remains the sole gate; `source_mode` only refines what is
 * extracted once source was requested.
 *
 * - `mixed` (default): body text for near spans (span mode 'full'), signature
 *   text for periphery spans (span mode 'signature').
 * - `body`: body text for every span with an export range.
 * - `signature`: signature text for every span with an export range.
 */
export type ContextPackSourceMode = 'signature' | 'body' | 'mixed';

/**
 * A bounded source snippet with provenance (issue #1533). Emitted one per
 * returned span that actually had text extracted; internal-symbol fallback
 * spans produce no snippet.
 *
 * `mode` describes the returned text, independent of the owning span's
 * traversal mode: 'full' = whole range text; 'signature' = signature-only
 * extraction; 'summary' = body text line-capped at 80 lines.
 *
 * `hash` is the sha256 hex of the returned `text` — a content fingerprint.
 * It is stable for a given source mode and file content; summary-mode hashes
 * are cap-dependent by design because the text itself is truncated.
 *
 * `confidence` is a deterministic resolution-quality score in [0, 1]:
 * 1.0 = the exact requested target symbol, 0.8 = a resolved neighbor with
 * extracted text. Spans whose read failed or which lack an export range
 * produce no snippet at all (their state surfaces via span.note, coverage,
 * and warnings). It is NOT language grammar quality; issue #1532 (KG-11
 * SymbolEdge v2) will replace this derivation with real edge confidence.
 */
export interface ContextPackSnippet {
	file: string;
	symbol: string;
	startLine: number;
	endLine: number;
	mode: 'full' | 'signature' | 'summary';
	text: string;
	hash: string;
	confidence: number;
}

/**
 * Coverage accounting for a context pack (issue #1533).
 *
 * `unresolvedEdges` and `lowConfidenceEdges` count distinct destination
 * SYMBOLS (keyed `file\0symbol`, collected at BFS first discovery), not edge
 * instances — duplicate edges toward the same unresolved symbol count once.
 * `lowConfidenceEdges` uses exactly the same predicate as the internal-symbol
 * span fallback (destination file present, no own-property export range for
 * the symbol), so coverage and spans can never disagree.
 */
export interface ContextPackCoverage {
	reachedSymbols: number;
	returnedSymbols: number;
	omittedByBudget: number;
	unresolvedEdges: number;
	lowConfidenceEdges: number;
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
	/** Whether source text was embedded in spans (only present when include_source was requested). */
	sourceIncluded?: boolean;
	/** Source snippets with provenance; only present when include_source was requested. */
	snippets?: ContextPackSnippet[];
	/** Reach/omission and edge-resolution accounting; present on every result. */
	coverage?: ContextPackCoverage;
	/** Bounded, deduplicated non-fatal warnings (budget omissions, read failures, containment). */
	warnings?: string[];
}

export interface AskHit {
	file: string;
	score: number;
	matchedTerms: string[];
	topExports: string[];
	role: string;
	community: string;
}

export interface AskOptions {
	topN?: number;
}

export interface AskResult {
	hits: AskHit[];
	expandedTerms: string[];
	budget: { requested: number; returned: number; dropped: number };
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

// ============ KG-14 expanded graph query results (issue #1535) ============

/** One symbol hit from `symbol_search`, with declaration metadata. */
export interface SymbolHit {
	/** Workspace-relative file path. */
	file: string;
	symbol: string;
	/** Declaration kind; `null` on graphs predating schema 1.6.0 (no exportKinds). */
	kind: GraphSymbolKind | null;
	visibility: GraphSymbolVisibility;
	language: string;
	/** 1-based definition line; 0 when no line is known. */
	line: number;
	exported: boolean;
	/** Which match tier produced this hit (results are tier-ordered). */
	match: 'exact' | 'prefix' | 'substring' | 'subsequence';
}

export interface SymbolSearchResult {
	query: string;
	hits: SymbolHit[];
	count: number;
	budget: { returned: number; dropped: number };
	/** False when the graph predates schema 1.6.0, so `kind` filters/hits degrade. */
	kindSupported: boolean;
	/** Present (non-empty) only when a filter or scan could not be fully applied. */
	warnings: string[];
}

/**
 * One symbol-level edge inside an impact cone. `relationshipKind`,
 * `confidence`, and `resolution` come from the underlying `SymbolEdge` and
 * are `null` for legacy (pre-1.5.0) edges.
 */
export interface ConeEntry {
	/** Workspace-relative file path. */
	file: string;
	symbol: string;
	direction: 'caller' | 'callee';
	/** 1 = direct neighbor of the target. */
	depth: number;
	relationshipKind: SymbolEdgeKind | null;
	confidence: number | null;
	resolution: SymbolEdgeResolution | null;
}

/** Focused definition-first context for one symbol. */
export interface SymbolContextResult {
	found: boolean;
	identity: {
		file: string;
		symbol: string;
		symbolId: string | null;
		kind: GraphSymbolKind | null;
		visibility: GraphSymbolVisibility;
		language: string;
		startLine: number;
		endLine: number | null;
	} | null;
	signature?: string;
	source?: {
		text: string;
		mode: 'full' | 'signature' | 'summary';
		hash: string;
		startLine: number;
		endLine: number;
	};
	callers: ConeEntry[];
	callees: ConeEntry[];
	/** Present only when resolution scanned stable IDs to match `symbolId`. */
	symbolIdScan?: { computed: number; capped: boolean };
	budget: { callersReturned: number; calleesReturned: number; dropped: number };
	warnings: string[];
	note?: string;
}

/** Structured impact cone for a file or file+symbol target. */
export interface ImpactConeResult {
	target: { file: string; symbol: string | null };
	/** Symbol-level entries (empty when no symbol was given or the graph has no symbolEdges). */
	entries: ConeEntry[];
	/** File-level blast radius for the same target and depth — risk semantics identical to `blast_radius`. */
	fileImpact: BlastRadiusResult;
	risk: BlastRadiusResult['riskLevel'];
	/** Fixed-vocabulary notes with counts (transitive spread, hubs, low-confidence edges, tests, boundaries). */
	riskNotes: string[];
	/** Cone files carrying the `test_file` role. */
	tests: string[];
	routes: Array<{ file: string; fact: RouteFact }>;
	dataFacts: Array<{ file: string; fact: DataOperationFact }>;
	securityFacts: Array<{ file: string; fact: SecurityFact }>;
	boundaries: Array<{ name: string; files: string[] }>;
	budget: { entriesReturned: number; dropped: number };
	truncated: boolean;
	warnings: string[];
}

/** One changed symbol mapped from a diff hunk (or listed file-level). */
export interface DiffSymbolChange {
	symbol: string;
	kind: GraphSymbolKind | null;
	startLine: number;
	endLine: number;
	/** Hunk-mode: changed graph lines that intersect the symbol span (bounded). */
	changedLines: number[];
}

export interface DiffFileSummary {
	/** Workspace-relative file path. */
	file: string;
	/** False when the changed file is not present in the graph (e.g. deleted or unscanned). */
	known: boolean;
	symbols: DiffSymbolChange[];
	note?: string;
}

export interface DiffContextResult {
	/** `hunk` when a diff text was parsed with line ranges; `file` when only file names were given. */
	granularity: 'hunk' | 'file';
	files: DiffFileSummary[];
	impact: {
		files: string[];
		tests: string[];
		risk: BlastRadiusResult['riskLevel'];
		notes: string[];
	};
	budget: { returned: number; dropped: number };
	truncated: boolean;
	warnings: string[];
}

/**
 * One reason a file/symbol/span is graph-relevant: its definition, the
 * symbol edges that connect it, or file-level import relationships.
 */
export interface ExplainReason {
	type:
		| 'definition'
		| 'referenced_by'
		| 'references'
		| 'imported_by'
		| 'imports';
	/** Workspace-relative file path of the OTHER side of the relationship (or the definition file). */
	file: string;
	symbol?: string;
	kind: GraphSymbolKind | null;
	relationshipKind?: SymbolEdgeKind;
	/** Undefined for definition/import reasons; `null`-able inside evidence-bearing edges is avoided by omitting. */
	confidence?: number;
	resolution?: SymbolEdgeResolution;
	evidence?: SymbolEdgeEvidence[];
}

export interface GraphExplainResult {
	target: { file: string; symbol: string | null; line: number | null };
	fileKnown: boolean;
	/** When `line` was given: the symbol whose span contains it (smallest span wins). */
	resolvedSpan?: { symbol: string; startLine: number; endLine: number };
	definition?: {
		file: string;
		symbol: string;
		kind: GraphSymbolKind | null;
		visibility: GraphSymbolVisibility;
		startLine: number;
		endLine: number | null;
	};
	reasons: ExplainReason[];
	budget: { returned: number; dropped: number };
	warnings: string[];
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

/** Build-time metadata witness for a non-node extractor input. */
export interface GraphExtractorInputWitness {
	/** Normalized workspace-relative path. */
	file: string;
	kind: 'manifest' | 'stable-skip';
	sizeBytes: number;
	mtimeMs: number;
}

export interface RepoGraphDiagnostics {
	extractionFailures?: GraphExtractionFailure[];
	unresolvedImports?: GraphUnresolvedImport[];
	oversizedFiles?: string[];
	unsupportedFiles?: string[];
	binaryFiles?: string[];
	unreadableFiles?: string[];
	/** Source files intentionally skipped because their extracted node failed validation. */
	validationSkippedFiles?: string[];
	/**
	 * Build-time witnesses for manifests and deterministic non-node skips.
	 * Persistence compares them against its live walk so an edit between graph
	 * extraction and sidecar persistence cannot be blessed as clean.
	 */
	extractorInputWitnesses?: GraphExtractorInputWitness[];
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
	probeState: FreshnessProbeState;
	staleFiles: string[];
	extractionFailures: GraphExtractionFailure[];
	unresolvedImports: GraphUnresolvedImport[];
	oversizedFiles: string[];
	unsupportedFiles: string[];
	binaryFiles: string[];
	unreadableFiles: string[];
	validationSkippedFiles: string[];
	lowConfidenceEdgeCount: number;
	unresolvedSymbolEdgeCount: number;
	walkTruncated: boolean;
	walkTruncationReason: 'budget' | 'cap' | null;
	incrementalFallbacks: number;
	notes: string[];
	/**
	 * KG-14 additive summaries (issue #1535). Optional on the interface so
	 * external constructors stay source-compatible; `getGraphHealth` always
	 * populates them (zero-valued when the underlying data is absent).
	 */
	/** Symbol-edge population summary (legacy edges counted under `withV2Fields: false`). */
	symbolEdgeSummary?: {
		total: number;
		withV2Fields: number;
		lowConfidence: number;
		unresolved: number;
	};
	/** Resolution-attribution histogram over symbol edges (includes `unrecorded`). */
	resolutionBreakdown?: Record<string, number>;
	/**
	 * Stale composition from the freshness probe; `null` when no probe was
	 * supplied. `probeTruncated` is `FreshnessProbe.truncated` — the freshness
	 * WALK hitting its budget — and is deliberately a different signal from
	 * build-time `walkTruncated` above (the graph BUILD walk).
	 */
	staleSummary?: {
		changed: number;
		removed: number;
		probeTruncated: boolean;
	} | null;
	/** Extraction-failure histogram keyed by failure reason. */
	extractionFailureSummary?: Record<string, number>;
	/** How many nodes carry schema 1.6.0 `exportKinds` data. */
	kindCoverage?: { nodesWithKinds: number; nodesTotal: number };
}

/** Authoritative states returned by the bounded repository freshness probe. */
export type FreshnessProbeState =
	| 'clean'
	| 'drifted'
	| 'no-fingerprint'
	| 'inconclusive';

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
	/** Root-independent repository label used to scope stable symbol IDs. */
	repoRootId?: string;
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
