/**
 * Safe load and save operations for repo-graph.json.
 *
 * All writes use an atomic temp-file + rename pattern to prevent partial
 * writes. Reads validate schema and content before updating the in-memory
 * cache. Symlink resolution guards against workspace-escape attacks.
 */
import type { RepoGraph } from './types';
/**
 * Get the validated path for the repo-graph.json file.
 * Resolves symlinks via realpath before validation to prevent
 * workspace-escaping attacks via symlink manipulation.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns Absolute path to repo-graph.json
 * @throws Error if path validation fails or resolved path escapes workspace
 */
export declare function getGraphPath(workspace: string): string;
/**
 * Load the graph from .swarm/repo-graph.json.
 * Uses the in-memory cache if available, not dirty, and file mtime unchanged.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The loaded graph or null if not found
 * @throws Error if file exists but is invalid/corrupted
 */
export declare function loadGraph(workspace: string): Promise<RepoGraph | null>;
/**
 * Save the graph to .swarm/repo-graph.json atomically.
 * Uses temp file + rename pattern to prevent partial writes.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @param graph - The graph to save
 * @param options.createAtomic - If true, fails if file already exists (for atomic create)
 * @throws Error if validation fails, write fails, or file exists when createAtomic=true
 */
export declare function saveGraph(workspace: string, graph: RepoGraph, options?: {
    createAtomic?: boolean;
}): Promise<void>;
/**
 * Load or create a graph for a workspace atomically.
 * Returns existing graph or creates a new empty one.
 * Handles concurrent creation by treating a create-fail as "graph exists".
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The existing or new graph
 */
export declare function loadOrCreateGraph(workspace: string): Promise<RepoGraph>;
/**
 * Save the cached graph for a workspace if it's dirty.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @throws Error if workspace is dirty but cache is missing (inconsistent state)
 * @throws Error if save fails
 */
export declare function saveIfDirty(workspace: string): Promise<void>;
