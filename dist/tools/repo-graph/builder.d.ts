/**
 * Workspace scanning and graph construction.
 *
 * Provides both synchronous (buildWorkspaceGraph) and async
 * (buildWorkspaceGraphAsync) builders that walk the file tree, extract
 * symbols, and produce a complete RepoGraph. The async variant yields
 * to the event loop between batches so the plugin host can continue
 * processing while a large workspace is scanned.
 *
 * Also exports upsertNode, addEdge, and resolveModuleSpecifier which are
 * used by both the builder and the incremental updater.
 */
import { extractPythonSymbols, extractTSSymbols } from '../symbols';
import { safeRealpathSync } from './safe-realpath';
import type { BuildWorkspaceGraphOptions, GraphEdge, GraphNode, RepoGraph } from './types';
/**
 * _internals DI seam for safeRealpathSync.
 * Defaults to the real implementation. Tests can override this to inject
 * mock behavior without calling mock.module(...) which leaks across test files
 * in Bun's shared test-runner process.
 */
export declare const _internals: {
    safeRealpathSync: typeof safeRealpathSync;
    extractTSSymbols: typeof extractTSSymbols;
    extractPythonSymbols: typeof extractPythonSymbols;
    parseFileImports: typeof parseFileImports;
};
/**
 * Add or update a node in the graph.
 * @param graph - The graph to modify
 * @param node - The node to add/update
 */
export declare function upsertNode(graph: RepoGraph, node: GraphNode): void;
/**
 * Add an edge to the graph.
 * @param graph - The graph to modify
 * @param edge - The edge to add
 */
export declare function addEdge(graph: RepoGraph, edge: GraphEdge): void;
/**
 * Resolve a module specifier relative to a source file within a workspace.
 *
 * CONTRACT for bare specifiers:
 * - Bare specifiers (e.g., 'lodash', 'zod', '@scope/pkg') return null because
 *   they require node_modules traversal to resolve, which is outside the scope
 *   of this module's responsibilities.
 * - Callers should treat null as "unresolvable at graph-build time" and may
 *   defer resolution to runtime or external tools.
 *
 * CONTRACT for workspace format:
 * - workspaceRoot is normally a relative path (e.g., "my-project") validated by
 *   validateWorkspace, but when called by buildWorkspaceGraph it may be an
 *   absolute scan root path. Both forms are accepted - the function handles
 *   path boundary checks consistently regardless of which form is provided.
 * - sourceFile must be an absolute path
 * - Returns absolute path if resolved, null otherwise
 *
 * @param workspaceRoot - The workspace root directory (relative or absolute path)
 * @param sourceFile - The file containing the import (absolute path)
 * @param specifier - The module specifier from the import statement
 * @returns Resolved absolute path or null if unresolvable
 */
export declare function resolveModuleSpecifier(workspaceRoot: string, sourceFile: string, specifier: string): string | null;
/**
 * A parsed import with its specifier and type.
 */
interface ParsedImport {
    /** The module specifier (e.g., './foo', 'lodash') */
    specifier: string;
    /** The type of import */
    importType: 'default' | 'named' | 'namespace' | 'require' | 'sideeffect';
}
/**
 * Parse imports from file content using the same rules as imports.ts.
 * Handles ES module imports and CommonJS require() statements.
 *
 * @param content - File content to parse
 * @returns Array of parsed imports with specifier and type
 */
declare function parseFileImports(content: string): ParsedImport[];
/**
 * Result of scanning a single file for graph updates.
 */
export interface ScanResult {
    /** The created node, or null if file was skipped */
    node: GraphNode | null;
    /** The edges created from this file's imports */
    edges: GraphEdge[];
}
/**
 * Scan a single file and extract its graph node and edges.
 * Reuses the same logic from buildWorkspaceGraph for consistency.
 *
 * @param filePath - Absolute path to the file to scan
 * @param absoluteRoot - Absolute path to workspace root
 * @param maxFileSize - Maximum file size in bytes
 * @returns ScanResult with node and edges
 */
export declare function scanFile(filePath: string, absoluteRoot: string, maxFileSize: number): ScanResult;
/**
 * Build a complete dependency graph for a workspace by scanning all source files.
 *
 * The scan is deterministic: files are processed in sorted order, and edges
 * are added in a stable order based on source file and import specifier.
 *
 * @param workspaceRoot - Workspace root directory (absolute or relative path)
 * @param options - Optional scan configuration
 * @param options.maxFileSizeBytes - Maximum file size to scan (default 1MB)
 * @returns Complete RepoGraph with nodes and edges
 * @throws Error if workspace validation fails
 */
export declare function buildWorkspaceGraph(workspaceRoot: string, options?: BuildWorkspaceGraphOptions): RepoGraph;
/**
 * Async, event-loop-safe variant of `buildWorkspaceGraph`. The traversal
 * yields between batches and uses async fs primitives, so callers can run
 * this from plugin init without freezing the host while a large workspace
 * is scanned. The per-file processing remains sync — it is CPU-bound symbol
 * extraction, and the existing per-file caps already prevent runaway work.
 *
 * Returned shape matches `buildWorkspaceGraph`. Same homedir guard, same
 * bounded walk behavior, same deterministic file order.
 */
export declare function buildWorkspaceGraphAsync(workspaceRoot: string, options?: BuildWorkspaceGraphOptions): Promise<RepoGraph>;
export {};
