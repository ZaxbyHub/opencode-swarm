/**
 * Repo graph data structures.
 *
 * The graph captures structural relationships between source files
 * (imports/exports) so agents can reason about blast radius before editing.
 *
 * All paths are RELATIVE to the workspace root and FORWARD-SLASH normalized
 * for cross-platform comparison.
 */

export type ImportType =
	| 'named'
	| 'default'
	| 'namespace'
	| 'sideeffect'
	| 'require'
	| 'type';

export interface ImportEdge {
	/** Importing file (relative, forward-slash). */
	source: string;
	/** Resolved imported file (relative, forward-slash). May be empty for unresolved imports. */
	target: string;
	/** Raw module specifier as written in the source (e.g. '../utils/path-security'). */
	rawModule: string;
	/** Named imports brought in (empty for sideeffect/namespace/default). */
	importedSymbols: string[];
	/** What kind of import statement this is. */
	importType: ImportType;
	/** 1-indexed line number where the import appears. */
	line: number;
}

export type SymbolKind =
	| 'function'
	| 'class'
	| 'interface'
	| 'type'
	| 'enum'
	| 'const'
	| 'variable'
	| 'method'
	| 'property';

export interface ExportedSymbol {
	name: string;
	kind: SymbolKind;
	signature?: string;
	line: number;
}

export interface FileNode {
	/** Relative, forward-slash path. */
	path: string;
	/** Detected language id (e.g. 'typescript', 'python', 'go', 'rust'). */
	language: string;
	/** Symbols this file exports (or top-level definitions for languages without explicit exports). */
	exports: ExportedSymbol[];
	/** Outgoing import edges from this file. */
	imports: ImportEdge[];
	/** mtime of the source file (ms epoch) for incremental updates. */
	mtimeMs: number;
}

export interface RepoGraph {
	/** Schema version for migration. */
	version: number;
	/** ISO timestamp when this graph was built. */
	buildTimestamp: string;
	/** Workspace root used at build time (absolute, for diagnostics only). */
	rootDir: string;
	/** Files keyed by their relative forward-slash path. */
	files: Record<string, FileNode>;
}

export interface FileReference {
	file: string;
	line?: number;
	importType?: ImportType;
}

export interface SymbolReference {
	file: string;
	line: number;
	importedAs: string; // alias if any, otherwise the symbol name
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
	/** Compact human/LLM-readable summary suitable for context injection. */
	summary: string;
}

export const REPO_GRAPH_SCHEMA_VERSION = 1;
export const REPO_GRAPH_FILENAME = 'repo-graph.json';
