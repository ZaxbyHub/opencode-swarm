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

import * as path from 'node:path';
import type { RepoGraph } from './types';

// ============ Module-Level Cache ============

/** In-memory cache of the loaded graph, keyed by workspace directory */
const graphCache = new Map<string, RepoGraph>();

/** Cache for modified/dirty state per workspace */
const dirtyFlags = new Map<string, boolean>();

/** Cache for file mtime (for cache invalidation), keyed by workspace directory */
const mtimeCache = new Map<string, number>();

// ============ Cache Operations ============

/**
 * Get the cached graph for a workspace.
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The cached graph or undefined if not cached
 */
export function getCachedGraph(workspace: string): RepoGraph | undefined {
	return graphCache.get(path.normalize(workspace));
}

/**
 * Set the cached graph for a workspace.
 * @param workspace - The workspace directory (absolute or relative path)
 * @param graph - The graph to cache
 * @param mtime - Optional file mtime to track for cache invalidation
 */
export function setCachedGraph(
	workspace: string,
	graph: RepoGraph,
	mtime?: number,
): void {
	const normalized = path.normalize(workspace);
	graphCache.set(normalized, graph);
	dirtyFlags.set(normalized, false);
	if (mtime !== undefined) {
		mtimeCache.set(normalized, mtime);
	}
}

/**
 * Mark a workspace's cache as dirty (modified since last save).
 * @param workspace - The workspace directory (absolute or relative path)
 */
export function markDirty(workspace: string): void {
	dirtyFlags.set(path.normalize(workspace), true);
}

/**
 * Check if a workspace's cache is dirty.
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns True if the cache has been modified since last save
 */
export function isDirty(workspace: string): boolean {
	return dirtyFlags.get(path.normalize(workspace)) ?? false;
}

/**
 * Clear the cache for a workspace.
 * @param workspace - The workspace directory (absolute or relative path)
 */
export function clearCache(workspace: string): void {
	const normalized = path.normalize(workspace);
	graphCache.delete(normalized);
	dirtyFlags.delete(normalized);
	mtimeCache.delete(normalized);
}

/**
 * Get the cached file mtime for a workspace (used for optimistic concurrency).
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The cached mtime in milliseconds, or undefined if not cached
 */
export function getCachedMtime(workspace: string): number | undefined {
	return mtimeCache.get(path.normalize(workspace));
}
