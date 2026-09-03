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
import type { FileLock } from '../../parallel/file-locks';
import { tryAcquireLock } from '../../parallel/file-locks';
import { sameProjectRoot } from '../../utils/canonical-root.js';
import * as logger from '../../utils/logger';
import {
	containsControlChars,
	validateSymlinkBoundary,
} from '../../utils/path-security';
import { assertProjectRoot } from '../../utils/project-boundary';
import {
	clearCache,
	getCachedGraph,
	getCachedMtime,
	isDirty,
	setCachedGraph,
} from './cache';
import { type FreshnessOptions, writeFingerprint } from './freshness';
import {
	deleteRepoMemory,
	resolveGraphStorageMode,
	syncIndexFromGraph,
} from './indexed-storage';
import { safeRealpathSync } from './safe-realpath';
import {
	deriveRepoRootId,
	hasSymbolEdgeV2Fields,
	normalizeSymbolEdge,
} from './symbol-edge';
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

// ============ Constants ============

/**
 * Maximum total rename attempts (initial + retries) for transient file-lock
 * errors (EEXIST, EPERM, EBUSY). Windows holds files open briefly during
 * handle release and during AV on-access scanning of newly written files.
 */
const WINDOWS_RENAME_MAX_RETRIES = 5;

/**
 * Delay between rename attempts (ms). 5 attempts → 4 sleeps → 400 ms total
 * worst-case wait. Intentionally higher than bun-compat.ts (3 attempts / 50 ms)
 * because saveGraph uses its own DI seam (_internals.fsRename / retryDelayMs)
 * rather than bunWrite, and this file requires the longer AV-scan window.
 *
 * No process.platform guard: EPERM from rename(2) can also arise on NFS/CIFS
 * mounts on Linux and macOS (not only on Windows AV). Unconditional retry
 * matches the existing bun-compat.ts pattern.
 */
const WINDOWS_RENAME_RETRY_DELAY_MS = 100;

// ============ DI Seam for Testability ============

/**
 * Internal function references for testability.
 * Replace _internals.safeRealpathSync in tests to mock symlink resolution.
 * Replace _internals.fsRename to exercise the rename retry path (e.g. EPERM).
 * Set _internals.retryDelayMs = 0 in tests to skip real sleeps while still
 * exercising multi-retry paths.
 * Restore each entry in afterEach via the saved original reference.
 */
export const _internals: {
	safeRealpathSync: typeof safeRealpathSync;
	fsRename: typeof fsPromises.rename;
	retryDelayMs: number;
	writeFingerprint: typeof writeFingerprint;
} = {
	safeRealpathSync,
	fsRename: fsPromises.rename.bind(fsPromises),
	retryDelayMs: WINDOWS_RENAME_RETRY_DELAY_MS,
	writeFingerprint,
};

function corruption(message: string, cause?: unknown): Error {
	return Object.assign(new Error(message), { code: 'CORRUPTION', cause });
}

function resolveTrustedWorkspaceRoot(workspace: string): string {
	const resolved = path.resolve(workspace);
	const trusted = _internals.safeRealpathSync(resolved, resolved);
	if (trusted === null) {
		throw corruption(`Workspace realpath security check failed: ${workspace}`);
	}
	return trusted;
}

function bindGraphToWorkspace(graph: RepoGraph, workspace: string): void {
	if (
		typeof graph.workspaceRoot !== 'string' ||
		graph.workspaceRoot.length === 0 ||
		containsControlChars(graph.workspaceRoot)
	) {
		throw corruption('repo-graph.json missing or invalid workspaceRoot');
	}
	const trustedWorkspace = resolveTrustedWorkspaceRoot(workspace);
	const persistedWorkspace = path.resolve(graph.workspaceRoot);
	const trustedPersisted = _internals.safeRealpathSync(
		persistedWorkspace,
		persistedWorkspace,
	);
	if (trustedPersisted === null) {
		throw corruption(
			`repo-graph.json workspaceRoot realpath security check failed: ${graph.workspaceRoot}`,
		);
	}
	if (!sameProjectRoot(trustedPersisted, trustedWorkspace)) {
		throw corruption(
			`repo-graph.json workspaceRoot mismatch: ${graph.workspaceRoot}`,
		);
	}
	graph.workspaceRoot = trustedWorkspace;
	graph.repoRootId = deriveRepoRootId(trustedWorkspace);
}

function validateLoadedGraph(parsed: RepoGraph, workspace: string): void {
	if (!parsed.schema_version) {
		throw corruption('repo-graph.json missing schema_version');
	}
	if (!parsed.nodes || typeof parsed.nodes !== 'object') {
		throw corruption('repo-graph.json missing or invalid nodes');
	}
	if (!Array.isArray(parsed.edges)) {
		throw corruption('repo-graph.json missing or invalid edges');
	}
	for (const [key, node] of Object.entries(parsed.nodes)) {
		if (!key || typeof key !== 'string') {
			throw corruption('repo-graph.json contains invalid node key');
		}
		try {
			validateGraphNode(node);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Invalid node structure';
			throw corruption(`repo-graph.json node validation failed: ${msg}`);
		}
	}
	for (const edge of parsed.edges) {
		try {
			validateGraphEdge(edge);
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Invalid edge structure';
			throw corruption(`repo-graph.json edge validation failed: ${msg}`);
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
		throw corruption('repo-graph.json missing or invalid metadata');
	}
	if (parsed.symbolEdges !== undefined) {
		if (!Array.isArray(parsed.symbolEdges)) {
			throw corruption('repo-graph.json symbolEdges must be an array');
		}
	}
	bindGraphToWorkspace(parsed, workspace);
	normalizeGraphSymbolEdges(parsed);
}

function normalizeGraphSymbolEdges(graph: RepoGraph): void {
	const repoRootId = deriveRepoRootId(graph.workspaceRoot);
	graph.repoRootId = repoRootId;
	if (!graph.symbolEdges) return;
	const normalized = [];
	for (const entry of graph.symbolEdges) {
		try {
			const validated = normalizeSymbolEdge(
				entry,
				graph.workspaceRoot,
				repoRootId,
			);
			normalized.push(hasSymbolEdgeV2Fields(entry) ? validated : entry);
		} catch (cause) {
			throw corruption(
				'repo-graph.json contains invalid symbolEdges entry',
				cause,
			);
		}
	}
	graph.symbolEdges = normalized;
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
		validateLoadedGraph(parsed, workspace);

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
		validateLoadedGraph(parsed, workspace);
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
 * Best-effort exclusive lock over the repo-graph write + index sync
 * (issue #1534, `indexed` mode only).
 *
 * Uses the repo's existing helper, which creates its sentinel INSIDE
 * `.swarm/locks/` (`file-locks.ts:6`). Calling `proper-lockfile` directly on
 * the `.swarm/` directory would instead create `<projectRoot>/.swarm.lock`
 * beside it — outside `.swarm/`, violating AGENTS.md invariant 4 and escaping
 * `ensureSwarmGitExcluded`.
 *
 * `tryAcquireLock` retries internally (5 retries, 10→500 ms, factor 2 —
 * `file-locks.ts:167-178`), bounding the wait at roughly 310 ms, then returns
 * `{ acquired: false }` rather than throwing. Returns null on ANY failure: the
 * JSON write is NEVER gated on the lock.
 */
async function acquireGraphSaveLock(
	workspace: string,
): Promise<FileLock | null> {
	try {
		// The lock creates durable state under `.swarm/locks/`; guard that
		// mutation boundary exactly as `withEvidenceLock` does (evidence/lock.ts:79).
		assertProjectRoot(workspace);
		const result = await tryAcquireLock(
			workspace,
			REPO_GRAPH_FILENAME,
			'repo-graph',
			'save-graph',
		);
		return result.acquired ? result.lock : null;
	} catch (error) {
		logger.log(
			`[repo-graph] repo-graph save lock unavailable, skipping index sync: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return null;
	}
}

/**
 * Release a lock taken by {@link acquireGraphSaveLock}.
 *
 * `releaseLock` in `file-locks.ts:196-206` is a documented NO-OP kept only for
 * API compatibility — "actual release is via lock._release() at the call site".
 * Calling it instead would leave the sentinel held for the full 5-minute stale
 * window, so every subsequent save in this process would fail acquisition and
 * silently stop syncing the index. Release failure is non-fatal
 * (`evidence/lock.ts:106-116`); a crashed holder is reclaimed by
 * `proper-lockfile`'s `stale` handling.
 */
async function releaseGraphSaveLock(lock: FileLock): Promise<void> {
	if (!lock._release) return;
	try {
		await lock._release();
	} catch {
		// Non-fatal: proper-lockfile's stale TTL reclaims an orphaned sentinel.
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

	if (!sameProjectRoot(realWorkspace, realGraphRoot)) {
		throw new Error(
			`Graph workspaceRoot mismatch: graph was built for "${graph.workspaceRoot}" but save was called for "${workspace}"`,
		);
	}
	graph.repoRootId = deriveRepoRootId(realWorkspace);

	// Normalize legacy edges and reject structurally or semantically invalid v2
	// facts before any write. This is the same trust boundary used by both loaders.
	normalizeGraphSymbolEdges(graph);

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

	// issue #1534: resolve the storage mode BEFORE the write, so that in
	// `indexed` mode one lock spans rename → stamp → sync. In the default
	// `json` mode nothing below acquires a lock and the write path is unchanged.
	const storageMode = resolveGraphStorageMode(workspace);
	const indexLock =
		storageMode === 'indexed' ? await acquireGraphSaveLock(workspace) : null;
	let indexStamp: { size: number; mtimeMs: number; ino: string } | null = null;

	let lastError: Error | null = null;

	try {
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
				// NOTE (issue #1534): this branch deliberately does NOT capture an
				// index stamp, so `indexStamp` stays null and the sync below is
				// skipped. The only production `createAtomic` caller is
				// `loadOrCreateGraph`, which writes `createEmptyGraph(...)` — an
				// empty graph with nothing worth indexing. Any existing index is
				// left alone; its stamp then mismatches, readers fall back to JSON,
				// and the next ordinary save repairs it. If `createAtomic` ever
				// gains a non-empty caller, hoist the stamp to cover both branches.
				// copyFile with COPYFILE_EXCL fails if target already exists
				try {
					await fsPromises.copyFile(
						tempPath,
						graphPath,
						constants.COPYFILE_EXCL,
					);
				} catch (error: unknown) {
					lastError = error instanceof Error ? error : new Error(String(error));
					throw lastError;
				}
			} else {
				// NORMATIVE (issue #1534, implementation-review finding B1) — stamp
				// THIS WRITER'S OWN BYTES, before the rename publishes them.
				//
				// `rename(2)` does not alter the inode's mtime or size, so a stat of
				// the temp file equals what the renamed file carries. Stamping AFTER
				// the rename instead stats *whatever is at the path by then*, and the
				// rename and the stat are two separate awaits: writer B (which failed
				// to take the lock and therefore renames unlocked — the JSON write is
				// never gated on the lock) can land in that gap, so A would stamp its
				// vA-content index with vB's stat and every reader's freshness check
				// would then PASS on superseded content. Stamping pre-rename inverts
				// that correctly: B's later rename changes the path's identity, the
				// reader's stat mismatches, and it falls back to JSON as intended.
				if (indexLock) {
					const stamped = await fsPromises.stat(tempPath);
					// `ino` is carried through `rename(2)` with the file, so it
					// distinguishes THIS writer's document from a competing one of
					// equal size written in the same mtime tick — which is the
					// common case, not a rare one (measured: identical byte length
					// 20/20, shared mtimeMs 146/200). Note the equal-length result
					// is EMPIRICAL, not structural: the ISO `mtime` is fixed-width
					// but nodes also carry a variable-width numeric `mtimeMs`
					// (types.ts:254), so size+mtime is unreliable in BOTH
					// directions — which is the point. Filesystems that do not supply a usable id
					// report 0; the reader then skips the comparison rather than
					// failing closed.
					indexStamp = {
						size: stamped.size,
						mtimeMs: stamped.mtimeMs,
						ino: String(stamped.ino ?? 0),
					};
				}
				// Retry rename on transient file-lock errors (EEXIST, EPERM, EBUSY).
				// No delete-then-rename fallback — retrying without delete eliminates
				// the TOCTOU window where a malicious file could be inserted between
				// unlink and rename. On Windows, rename over a locked target returns
				// EPERM (e.g. AV on-access scan) or EEXIST; EBUSY is also retried for
				// consistency with the rest of the codebase (bun-compat.ts).
				// _internals.retryDelayMs can be set to 0 in tests for instant retries.
				for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
					try {
						await _internals.fsRename(tempPath, graphPath);
						lastError = null;
						break;
					} catch (error: unknown) {
						lastError =
							error instanceof Error ? error : new Error(String(error));
						const code = (lastError as NodeJS.ErrnoException).code;
						if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
							break;
						}
						if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
							await new Promise((resolve) =>
								setTimeout(resolve, _internals.retryDelayMs),
							);
						}
					}
				}
				if (lastError) {
					throw lastError;
				}
			}
		} finally {
			// Clean up temp file.
			// Rename success: temp was moved to graphPath, so unlink throws ENOENT — ignored.
			// Rename exhausted retries (e.g. persistent Windows EPERM): temp still exists.
			//   If AV also holds the temp file, unlink throws EPERM — logged but not thrown.
			//   Orphaned files are unique-named (Date.now() + random), so they do not
			//   accumulate pathologically and are cleaned up on the next successful save.
			// createAtomic path: temp still exists after copyFile and must be removed.
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

		// Index maintenance (issue #1534). Reached only after the JSON write
		// succeeded, and every failure here is swallowed: the JSON document is the
		// durability point and remains authoritative in both modes.
		//
		// `json` mode deletes any existing index, so a config flip back to `json`
		// is belt-and-braces with the readers' own config gate.
		//
		// `indexed` mode syncs ONLY when the lock was acquired. On acquisition
		// failure the rename above still happened, the sync is skipped, and the
		// existing index is left UNTOUCHED (deleting it could disrupt a concurrent
		// writer mid-transaction). Its stamp then mismatches, every reader falls
		// back to JSON, and the next successful save repairs it.
		try {
			if (storageMode === 'json') {
				deleteRepoMemory(workspace);
			} else if (indexLock && indexStamp) {
				await syncIndexFromGraph(workspace, graph, indexStamp);
			}
		} catch (error) {
			logger.log(
				`[repo-graph] repo-memory maintenance failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	} finally {
		if (indexLock) {
			await releaseGraphSaveLock(indexLock);
		}
	}

	// Update cache with current file mtime. Best-effort: the document is
	// already durably renamed at this point, so a cache-refresh failure must
	// not surface to the caller as a save failure — the entry self-invalidates
	// against the next read's fresh stat instead.
	// NOTE (issue #1534): this stat MUST NOT be reused as the index stamp — it is
	// taken outside the save lock and stats WHATEVER IS AT THE PATH, so a
	// concurrent unlocked writer's rename could validate an index holding THIS
	// writer's superseded content. The stamp is captured inside the lock
	// immediately BEFORE the rename above, from a stat of the TEMP file, so it
	// identifies this writer's own bytes (`rename(2)` leaves the inode's mtime
	// and size untouched). Do not "simplify" the two into one stat.
	try {
		const stats = await fsPromises.stat(graphPath);
		setCachedGraph(normalized, graph, stats.mtimeMs);
	} catch (error) {
		logger.log(
			`[repo-graph] post-save cache refresh failed (document was written): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
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
export async function saveIfDirty(
	workspace: string,
	freshnessOptions?: FreshnessOptions,
): Promise<void> {
	const normalized = path.normalize(workspace);
	if (isDirty(normalized)) {
		const graph = getCachedGraph(normalized);
		if (!graph) {
			throw new Error(
				`Cannot save dirty graph for workspace "${workspace}": cache is missing`,
			);
		}
		await saveGraph(workspace, graph);
		await _internals.writeFingerprint(workspace, graph, freshnessOptions);
	}
}
