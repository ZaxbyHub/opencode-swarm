/**
 * Bounded in-memory cache for loaded repo graphs.
 *
 * Graph, dirty, and mtime state intentionally share one entry so eviction can
 * never leave one piece of workspace state behind. Entries are keyed by an
 * absolute normalized workspace path and maintained as a true LRU: every read
 * moves the entry to the newest position and insertion evicts the oldest.
 */

import * as path from 'node:path';
import type { RepoGraph } from './types';

const MAX_CACHED_WORKSPACES = 16;

interface CacheEntry {
	graph?: RepoGraph;
	dirty: boolean;
	mtime?: number;
}

/** Oldest entry is first, newest entry is last. */
const workspaceCache = new Map<string, CacheEntry>();

function normalizeWorkspace(workspace: string): string {
	const resolved = path.normalize(path.resolve(workspace));
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function touch(key: string, entry: CacheEntry): CacheEntry {
	workspaceCache.delete(key);
	workspaceCache.set(key, entry);
	return entry;
}

function getEntry(workspace: string): CacheEntry | undefined {
	const key = normalizeWorkspace(workspace);
	const entry = workspaceCache.get(key);
	return entry ? touch(key, entry) : undefined;
}

function setEntry(workspace: string, entry: CacheEntry): void {
	const key = normalizeWorkspace(workspace);
	touch(key, entry);
	while (workspaceCache.size > MAX_CACHED_WORKSPACES) {
		const oldestKey = workspaceCache.keys().next().value as string | undefined;
		if (oldestKey === undefined) break;
		workspaceCache.delete(oldestKey);
	}
}

/** Return the cached graph for a workspace, if present. */
export function getCachedGraph(workspace: string): RepoGraph | undefined {
	return getEntry(workspace)?.graph;
}

/**
 * Cache a graph and mark it clean. Omitting mtime clears any previous mtime so
 * an old optimistic-concurrency witness cannot survive a new graph value.
 */
export function setCachedGraph(
	workspace: string,
	graph: RepoGraph,
	mtime?: number,
): void {
	setEntry(workspace, {
		graph,
		dirty: false,
		...(mtime === undefined ? {} : { mtime }),
	});
}

/** Mark a workspace's cached state dirty, preserving its graph and mtime. */
export function markDirty(workspace: string): void {
	const existing = getEntry(workspace);
	setEntry(workspace, {
		...(existing ?? {}),
		dirty: true,
	});
}

/** Return whether the workspace's cached state is dirty. */
export function isDirty(workspace: string): boolean {
	return getEntry(workspace)?.dirty ?? false;
}

/** Remove all cached state for one workspace. */
export function clearCache(workspace: string): void {
	workspaceCache.delete(normalizeWorkspace(workspace));
}

/** Return the graph-file mtime captured with the cached graph, if present. */
export function getCachedMtime(workspace: string): number | undefined {
	return getEntry(workspace)?.mtime;
}
