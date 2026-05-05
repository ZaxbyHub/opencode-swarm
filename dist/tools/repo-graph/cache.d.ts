/**
 * In-memory cache for loaded repo graphs.
 *
 * Three maps keyed by normalized workspace path:
 * - graphCache  — the last loaded/saved RepoGraph for each workspace
 * - dirtyFlags  — whether the cached graph has been modified since the last save
 * - mtimeCache  — the file mtime at the time the graph was last loaded/saved,
 *                 used by the optimistic concurrency check in incremental.ts
 *
 * All public functions normalize the workspace path before use so callers
 * are not required to pre-normalize.
 */
import type { RepoGraph } from './types';
/**
 * Get the cached graph for a workspace.
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The cached graph or undefined if not cached
 */
export declare function getCachedGraph(workspace: string): RepoGraph | undefined;
/**
 * Set the cached graph for a workspace.
 * @param workspace - The workspace directory (absolute or relative path)
 * @param graph - The graph to cache
 * @param mtime - Optional file mtime to track for cache invalidation
 */
export declare function setCachedGraph(workspace: string, graph: RepoGraph, mtime?: number): void;
/**
 * Mark a workspace's cache as dirty (modified since last save).
 * @param workspace - The workspace directory (absolute or relative path)
 */
export declare function markDirty(workspace: string): void;
/**
 * Check if a workspace's cache is dirty.
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns True if the cache has been modified since last save
 */
export declare function isDirty(workspace: string): boolean;
/**
 * Clear the cache for a workspace.
 * @param workspace - The workspace directory (absolute or relative path)
 */
export declare function clearCache(workspace: string): void;
/**
 * Get the cached file mtime for a workspace (used for optimistic concurrency).
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The cached mtime in milliseconds, or undefined if not cached
 */
export declare function getCachedMtime(workspace: string): number | undefined;
