/**
 * Incremental graph updates for changed files.
 *
 * updateGraphForFiles re-scans only the specified changed files, updates
 * their nodes and edges in the existing graph, and saves the result. It
 * includes an optimistic concurrency check (mtime comparison) so that
 * concurrent sessions do not overwrite each other's updates — when a race
 * is detected the function falls back to a full rebuild.
 */
import type { RepoGraph } from './types';
/**
 * Incrementally update the graph for a set of changed files.
 * Re-scans only the specified files, updates their nodes and edges,
 * and falls back to a full rebuild if the incremental pass cannot be validated.
 *
 * @param workspaceRoot - Workspace root directory (relative path)
 * @param filePaths - Array of absolute file paths that changed
 * @param options - Optional configuration
 * @param options.forceRebuild - Force a full rebuild instead of incremental
 * @returns Updated RepoGraph
 */
export declare function updateGraphForFiles(workspaceRoot: string, filePaths: string[], options?: {
    forceRebuild?: boolean;
}): Promise<RepoGraph>;
