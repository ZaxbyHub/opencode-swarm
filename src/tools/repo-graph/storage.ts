/**
 * Safe load and save operations for repo-graph.json.
 *
 * All writes use an atomic temp-file + rename pattern to prevent partial
 * writes. Reads validate schema and content before updating the in-memory
 * cache. Symlink resolution guards against workspace-escape attacks.
 */

import { constants, existsSync, readFileSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { validateSwarmPath } from '../../hooks/utils';
import * as logger from '../../utils/logger';
import { validateSymlinkBoundary } from '../../utils/path-security';
import {
	clearCache,
	getCachedGraph,
	getCachedMtime,
	isDirty,
	setCachedGraph,
} from './cache';
import { safeRealpathSync } from './safe-realpath';
import type { RepoGraph } from './types';
import {
	createEmptyGraph,
	REPO_GRAPH_FILENAME,
	updateGraphMetadata,
} from './types';
import {
	validateGraphEdge,
	validateGraphNode,
	validateWorkspace,
} from './validation';

// ============ DI Seam for Testability ============

/**
 * Internal function references for testability.
 * Replace _internals.safeRealpathSync in tests to mock symlink resolution.
 */
export const _internals: {
	safeRealpathSync: typeof safeRealpathSync;
} = {
	safeRealpathSync,
} as const;

// ============ Constants ============

/**
 * Maximum number of rename retries on Windows EEXIST errors.
 * Windows may hold the file open briefly during handle release.
 */
const WINDOWS_RENAME_MAX_RETRIES = 3;

/**
 * Delay between rename retries on Windows (ms).
 */
const WINDOWS_RENAME_RETRY_DELAY_MS = 50;

function validateLoadedGraph(parsed: RepoGraph): void {
	if (!parsed.schema_version) {
		throw Object.assign(new Error('repo-graph.json missing schema_version'), {
			code: 'CORRUPTION',
		});
	}
	if (!parsed.nodes || typeof parsed.nodes !== 'object') {
		throw Object.assign(new Error('repo-graph.json missing or invalid nodes'), {
			code: 'CORRUPTION',
		});
	}
	if (!Array.isArray(parsed.edges)) {
		throw Object.assign(new Error('repo-graph.json missing or invalid edges'), {
			code: 'CORRUPTION',
		});
	}
	for (const [key, node] of Object.entries(parsed.nodes)) {
		if (!key || typeof key !== 'string') {
			throw Object.assign(
				new Error('repo-graph.json contains invalid node key'),
				{ code: 'CORRUPTION' },
			);
		}
		try {
			validateGraphNode(node);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Invalid node structure';
			throw Object.assign(
				new Error(`repo-graph.json node validation failed: ${msg}`),
				{ code: 'CORRUPTION' },
			);
		}
	}
	for (const edge of parsed.edges) {
		try {
			validateGraphEdge(edge);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Invalid edge structure';
			throw Object.assign(
				new Error(`repo-graph.json edge validation failed: ${msg}`),
				{ code: 'CORRUPTION' },
			);
		}
	}
	if (
		!parsed.metadata ||
		typeof parsed.metadata !== 'object' ||
		typeof parsed.metadata.generatedAt !== 'string' ||
		typeof parsed.metadata.generator !== 'string' ||
		typeof parsed.metadata.nodeCount !== 'number' ||
		typeof parsed.metadata.edgeCount !== 'number'
	) {
		throw Object.assign(
			new Error('repo-graph.json missing or invalid metadata'),
			{ code: 'CORRUPTION' },
		);
	}
}

// ============ Safe Load/Save Operations ============

/**
 * Get the validated path for the repo-graph.json file.
 * Resolves symlinks via realpath before validation to prevent
 * workspace-escaping attacks via symlink manipulation.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns Absolute path to repo-graph.json
 * @throws Error if path validation fails or resolved path escapes workspace
 */
export function getGraphPath(workspace: string): string {
	validateWorkspace(workspace);
	const basePath = validateSwarmPath(workspace, REPO_GRAPH_FILENAME);

	// SECURITY: Resolve symlinks to verify graph path stays within workspace
	validateSymlinkBoundary(basePath, workspace);

	return basePath;
}

/**
 * Load the graph from .swarm/repo-graph.json.
 * Uses the in-memory cache if available, not dirty, and file mtime unchanged.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The loaded graph or null if not found
 * @throws Error if file exists but is invalid/corrupted
 */
export async function loadGraph(workspace: string): Promise<RepoGraph | null> {
	validateWorkspace(workspace);
	const normalized = path.normalize(workspace);

	// Check cache first (only valid if not dirty)
	const cached = getCachedGraph(normalized);
	if (cached && !isDirty(normalized)) {
		// Invalidate cache if file mtime changed since last load
		try {
			const graphPath = getGraphPath(workspace);
			if (existsSync(graphPath)) {
				const stats = await fsPromises.stat(graphPath);
				const cachedMtime = getCachedMtime(normalized);
				if (cachedMtime !== undefined && stats.mtimeMs !== cachedMtime) {
					// File was modified externally - invalidate cache
					clearCache(normalized);
				} else {
					return cached;
				}
			} else {
				// File deleted since last cache - invalidate
				clearCache(normalized);
			}
		} catch {
			// If we can't stat the file, don't use cache
			clearCache(normalized);
		}
	}

	try {
		const graphPath = getGraphPath(workspace);

		if (!existsSync(graphPath)) {
			// No graph file exists yet
			return null;
		}

		const stats = await fsPromises.stat(graphPath);
		const content = await fsPromises.readFile(graphPath, 'utf-8');

		// SECURITY: Reject content with null bytes or invalid UTF-8
		if (content.includes('\0') || content.includes('\uFFFD')) {
			throw Object.assign(
				new Error('repo-graph.json contains null bytes or invalid encoding'),
				{ code: 'CORRUPTION' },
			);
		}

		let parsed: RepoGraph;
		try {
			parsed = JSON.parse(content) as RepoGraph;
		} catch {
			throw Object.assign(new Error('repo-graph.json contains invalid JSON'), {
				code: 'CORRUPTION',
			});
		}
		validateLoadedGraph(parsed);

		// Update cache with current file mtime
		setCachedGraph(normalized, parsed, stats.mtimeMs);

		return parsed;
	} catch (error: unknown) {
		// Re-throw structured corruption errors
		if (
			error instanceof Error &&
			'code' in error &&
			(error as { code: string }).code === 'CORRUPTION'
		) {
			throw error;
		}
		// Only return null for ENOENT (file not found); rethrow other I/O errors
		if (
			error instanceof Error &&
			'code' in error &&
			(error as { code: string }).code === 'ENOENT'
		) {
			return null;
		}
		throw error;
	}
}

/**
 * Synchronous graph loader for prompt-injection hooks.
 *
 * Mirrors loadGraph validation but avoids async file I/O in system prompt
 * construction. Returns null only when the graph file is absent.
 */
export function loadGraphSync(workspace: string): RepoGraph | null {
	validateWorkspace(workspace);
	const normalized = path.normalize(workspace);
	try {
		const graphPath = getGraphPath(workspace);
		if (!existsSync(graphPath)) return null;
		const stats = statSync(graphPath);
		const content = readFileSync(graphPath, 'utf-8');
		if (content.includes('\0') || content.includes('\uFFFD')) {
			throw Object.assign(
				new Error('repo-graph.json contains null bytes or invalid encoding'),
				{ code: 'CORRUPTION' },
			);
		}
		let parsed: RepoGraph;
		try {
			parsed = JSON.parse(content) as RepoGraph;
		} catch {
			throw Object.assign(new Error('repo-graph.json contains invalid JSON'), {
				code: 'CORRUPTION',
			});
		}
		validateLoadedGraph(parsed);
		setCachedGraph(normalized, parsed, stats.mtimeMs);
		return parsed;
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error as { code: string }).code === 'ENOENT'
		) {
			return null;
		}
		throw error;
	}
}

/**
 * Save the graph to .swarm/repo-graph.json atomically.
 * Uses temp file + rename pattern to prevent partial writes.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @param graph - The graph to save
 * @param options.createAtomic - If true, fails if file already exists (for atomic create)
 * @throws Error if validation fails, write fails, or file exists when createAtomic=true
 */
export async function saveGraph(
	workspace: string,
	graph: RepoGraph,
	options?: { createAtomic?: boolean },
): Promise<void> {
	validateWorkspace(workspace);

	// Validate graph structure
	if (!graph.schema_version) {
		throw new Error('Graph must have schema_version');
	}
	if (!graph.nodes || typeof graph.nodes !== 'object') {
		throw new Error('Graph must have nodes object');
	}
	if (!Array.isArray(graph.edges)) {
		throw new Error('Graph must have edges array');
	}

	// SECURITY: Validate that the graph's workspaceRoot matches the active workspace.
	// This prevents a TOCTOU attack where a graph saved for one workspace could
	// be swapped with a graph from another workspace.
	const normalizedWorkspace = path.normalize(workspace);
	const realWorkspace = _internals.safeRealpathSync(
		workspace,
		normalizedWorkspace,
	);
	if (realWorkspace === null) {
		throw new Error(
			`Workspace realpath security check failed (non-ENOENT): ${workspace}`,
		);
	}

	const normalizedGraphRoot = path.normalize(graph.workspaceRoot);
	const realGraphRoot = _internals.safeRealpathSync(
		graph.workspaceRoot,
		normalizedGraphRoot,
	);
	if (realGraphRoot === null) {
		throw new Error(
			`Graph workspaceRoot realpath security check failed (non-ENOENT): ${graph.workspaceRoot}`,
		);
	}

	if (path.normalize(realWorkspace) !== path.normalize(realGraphRoot)) {
		throw new Error(
			`Graph workspaceRoot mismatch: graph was built for "${graph.workspaceRoot}" but save was called for "${workspace}"`,
		);
	}

	const normalized = normalizedWorkspace;

	// Get validated path
	const graphPath = getGraphPath(workspace);

	// Update metadata before saving
	updateGraphMetadata(graph);

	// Atomic write: temp file + rename
	const tempPath = `${graphPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;

	// Defensively create .swarm/ directory before write to prevent race condition
	// on first initialization where async write races ahead of directory creation
	await fsPromises.mkdir(path.dirname(tempPath), { recursive: true });

	let lastError: Error | null = null;

	try {
		// For atomic create, use exclusive open
		if (options?.createAtomic) {
			try {
				const handle = await fsPromises.open(tempPath, 'wx', 0o644);
				await handle.writeFile(JSON.stringify(graph, null, 2), 'utf-8');
				await handle.close();
			} catch (error: unknown) {
				if (
					error instanceof Error &&
					'code' in error &&
					(error as { code: string }).code === 'EEXIST'
				) {
					throw new Error('file already exists');
				}
				throw error;
			}
		} else {
			await fsPromises.writeFile(
				tempPath,
				JSON.stringify(graph, null, 2),
				'utf-8',
			);
		}

		// For createAtomic: use copy with COPYFILE_EXCL to fail if target exists.
		// This is different from rename which overwrites on Windows.
		// For non-createAtomic: use rename with Windows retry loop.
		if (options?.createAtomic) {
			// copyFile with COPYFILE_EXCL fails if target already exists
			try {
				await fsPromises.copyFile(tempPath, graphPath, constants.COPYFILE_EXCL);
			} catch (error: unknown) {
				lastError = error instanceof Error ? error : new Error(String(error));
				throw lastError;
			}
		} else {
			// On Windows, rename may fail if target exists and is open.
			// Retry the rename without deleting the target (no delete-then-rename
			// fallback) to eliminate the TOCTOU window where an attacker could
			// create a malicious file at graphPath between delete and rename.
			let retries = 0;
			while (retries < WINDOWS_RENAME_MAX_RETRIES) {
				try {
					await fsPromises.rename(tempPath, graphPath);
					break;
				} catch (error: unknown) {
					lastError = error instanceof Error ? error : new Error(String(error));
					// Only retry on Windows EEXIST error
					if (
						lastError instanceof Error &&
						'code' in lastError &&
						(lastError as { code: string }).code === 'EEXIST' &&
						retries < WINDOWS_RENAME_MAX_RETRIES - 1
					) {
						retries++;
						// Wait before retry to allow handle release
						await new Promise((resolve) =>
							setTimeout(resolve, WINDOWS_RENAME_RETRY_DELAY_MS),
						);
						continue;
					}
					// Not an EEXIST error or max retries reached - throw
					throw lastError;
				}
			}
		}
	} finally {
		// Clean up temp file.
		// For rename path: temp is gone after successful rename, so unlink fails with
		// ENOENT which is ignored. For copy path (createAtomic): temp still exists and
		// must be explicitly removed.
		try {
			await fsPromises.unlink(tempPath);
		} catch (error: unknown) {
			// Log but don't throw - the write/rename failure is the primary error
			if (
				error instanceof Error &&
				'code' in error &&
				(error as { code: string }).code !== 'ENOENT'
			) {
				logger.error(`Failed to clean up temp file ${tempPath}:`, error);
			}
		}
	}

	// Update cache with current file mtime
	const stats = await fsPromises.stat(graphPath);
	setCachedGraph(normalized, graph, stats.mtimeMs);
}

/**
 * Load or create a graph for a workspace atomically.
 * Returns existing graph or creates a new empty one.
 * Handles concurrent creation by treating a create-fail as "graph exists".
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @returns The existing or new graph
 */
export async function loadOrCreateGraph(workspace: string): Promise<RepoGraph> {
	// First try to load existing graph
	const existing = await loadGraph(workspace);
	if (existing) {
		return existing;
	}

	// No existing graph - try to create one atomically
	const newGraph = createEmptyGraph(workspace);

	// Attempt atomic save with exclusive create flag
	// This will fail if another process created the file first
	try {
		await saveGraph(workspace, newGraph, { createAtomic: true });
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes('file already exists')
		) {
			// Another process beat us - reload their graph
			const retry = await loadGraph(workspace);
			if (retry) {
				return retry;
			}
			// Edge case: file disappeared between our create attempt and reload
			// Retry save without exclusive flag (file doesn't exist anymore)
			await saveGraph(workspace, newGraph);
		} else {
			throw error;
		}
	}

	setCachedGraph(workspace, newGraph);
	return newGraph;
}

/**
 * Save the cached graph for a workspace if it's dirty.
 *
 * @param workspace - The workspace directory (absolute or relative path)
 * @throws Error if workspace is dirty but cache is missing (inconsistent state)
 * @throws Error if save fails
 */
export async function saveIfDirty(workspace: string): Promise<void> {
	const normalized = path.normalize(workspace);
	if (isDirty(normalized)) {
		const graph = getCachedGraph(normalized);
		if (!graph) {
			throw new Error(
				`Cannot save dirty graph for workspace "${workspace}": cache is missing`,
			);
		}
		await saveGraph(workspace, graph);
	}
}
