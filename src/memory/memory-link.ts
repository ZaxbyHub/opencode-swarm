/**
 * #1850 Linked Knowledge 5/5: memory link pointer + resolution cache.
 *
 * Mirrors `src/hooks/knowledge-link.ts` for the memory subsystem. The pointer
 * lives at `<directory>/.swarm/memory-link.json` — a SEPARATE pointer from the
 * knowledge `link.json`. This deliberate split satisfies issue #1850 acceptance
 * #1 (memory sharing is independently opt-in) and #2 (status distinguishes
 * knowledge link from memory link). Both pointers carry the same canonical
 * cohort id from #1846 — they identify the same cohort — but toggling one does
 * not toggle the other.
 *
 * The shared cohort store lives at `<dataDir>/links/<linkId>/` (reusing
 * `resolveLinkBaseDir` / `resolveLinkDir` from `knowledge-link.ts`). Memory
 * occupies the `memory/` subdirectory of that cohort container, keeping
 * knowledge and memory family files siblings without filename collisions.
 *
 * Reuses from `knowledge-link.ts`:
 *  - `resolveLinkBaseDir`, `resolveLinkDir`, `sanitizeLinkId` — the cohort
 *    directory layout and id sanitization are shared infrastructure (one
 *    cohort container per cohort id).
 *
 * Does NOT duplicate the platform data-dir logic (Windows LOCALAPPDATA, macOS
 * Application Support, linux XDG) — that lives once in `knowledge-link.ts`.
 *
 * Cross-process revalidation (issue #1850 §6 "bounded revalidation window"):
 * like the knowledge resolver, a cache hit re-stats the pointer file and
 * invalidates on `mtimeMs:ctimeMs:size` change, so a sibling worktree's
 * `/swarm memory link` / `/swarm memory unlink` is observed without restart
 * and without waiting for the TTL backstop.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	resolveLinkBaseDir,
	resolveLinkDir,
	sanitizeLinkId,
} from '../hooks/knowledge-link.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import { warn } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/** On-disk pointer at `<directory>/.swarm/memory-link.json`. */
export interface MemoryLinkPointer {
	/** Pointer schema version. */
	version: 1 | 2;
	/** Sanitized link id (cohort directory segment). */
	linkId: string;
	/** Human-friendly name when the link was created from an explicit name. */
	name?: string;
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** Canonical cohort id from `resolveCohortId` (issue #1846). */
	cohortId?: string;
	/** How the cohort id was derived. */
	identitySource?: 'remote' | 'git-common-dir' | 'path';
	/** True when the cohort id is machine-local (not portable). */
	degraded?: boolean;
	/** Memory cohort config fingerprint (provider/schema/embedding/redaction). */
	configFingerprint?: string;
	/** Monotonic generation counter, bumped on each link/unlink. */
	generation?: number;
}

// ============================================================================
// Constants
// ============================================================================

export const MEMORY_LINK_POINTER_FILENAME = 'memory-link.json';

/** Cache TTL — mirrors `knowledge-link.ts` `CACHE_TTL_MS`. */
const CACHE_TTL_MS = 2_000;

/** Bounded cache (Invariant 8: module-level state needs explicit eviction). */
const MAX_CACHE_ENTRIES = 500;

// ============================================================================
// Pointer read / write / remove
// ============================================================================

function resolveMemoryLinkPointerPath(directory: string): string {
	return path.join(directory, '.swarm', MEMORY_LINK_POINTER_FILENAME);
}

/**
 * Read and validate the memory link pointer for a worktree. Null if absent or
 * malformed (fail-open — a corrupt pointer never strands memory; it degrades
 * to local).
 */
export function readMemoryLinkPointer(
	directory: string,
): MemoryLinkPointer | null {
	const pointerPath = resolveMemoryLinkPointerPath(directory);
	if (!existsSync(pointerPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(pointerPath, 'utf-8')) as unknown;
		if (!raw || typeof raw !== 'object') return null;
		const obj = raw as Record<string, unknown>;
		const linkId = obj.linkId;
		if (typeof linkId !== 'string' || linkId.length === 0) return null;
		// Re-sanitize on read: the linkId becomes a path segment.
		const safeId = sanitizeLinkId(linkId);
		if (!safeId) return null;
		const rawVersion = obj.version;
		const version: 1 | 2 = rawVersion === 2 ? 2 : 1;
		return {
			version,
			linkId: safeId,
			name: typeof obj.name === 'string' ? obj.name : undefined,
			createdAt:
				typeof obj.createdAt === 'string'
					? obj.createdAt
					: new Date(0).toISOString(),
			cohortId: typeof obj.cohortId === 'string' ? obj.cohortId : undefined,
			identitySource:
				obj.identitySource === 'remote' ||
				obj.identitySource === 'git-common-dir' ||
				obj.identitySource === 'path'
					? obj.identitySource
					: undefined,
			degraded: typeof obj.degraded === 'boolean' ? obj.degraded : undefined,
			configFingerprint:
				typeof obj.configFingerprint === 'string'
					? obj.configFingerprint
					: undefined,
			generation:
				typeof obj.generation === 'number' ? obj.generation : undefined,
		};
	} catch {
		return null;
	}
}

/** Write the memory link pointer atomically and invalidate the cache. */
export async function writeMemoryLinkPointer(
	directory: string,
	pointer: MemoryLinkPointer,
): Promise<void> {
	const swarmDir = path.join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const pointerPath = resolveMemoryLinkPointerPath(directory);
	await atomicWriteFile(pointerPath, JSON.stringify(pointer, null, 2));
	invalidateMemoryStoreDirCache(directory);
}

/** Remove the memory link pointer (idempotent) and invalidate the cache. */
export async function removeMemoryLinkPointer(
	directory: string,
): Promise<void> {
	const pointerPath = resolveMemoryLinkPointerPath(directory);
	try {
		rmSync(pointerPath, { force: true });
	} finally {
		invalidateMemoryStoreDirCache(directory);
	}
}

// ============================================================================
// Resolution (the seam used by resolveVettedMemoryRoot)
// ============================================================================

interface CacheEntry {
	linkDir: string | null;
	expires: number;
	/** Pointer-file stat fingerprint for cross-process revalidation. */
	pointerStat: string | null;
}

const _resolutionCache = new Map<string, CacheEntry>();

/**
 * Build the stat fingerprint for the pointer file. Returns null when absent
 * (so an absent→present transition is detected as a change). Includes ctimeMs
 * because Windows rename preserves mtimeMs (mirrors knowledge-link.ts:365).
 */
function pointerStatFingerprint(directory: string): string | null {
	const pointerPath = resolveMemoryLinkPointerPath(directory);
	try {
		const st = statSync(pointerPath);
		return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
	} catch {
		return null;
	}
}

/**
 * Resolve the directory that holds the cohort store for `directory`.
 *
 * Returns the shared link directory (`<dataDir>/links/<linkId>`) when an active
 * memory-link pointer is present, otherwise the local `<directory>/.swarm`.
 * Fail-open: any read/parse error degrades to local. Synchronous and cached;
 * on a cache hit a cheap `stat` revalidates cross-process changes so the hot
 * recall path stays fast while observing link/unlink without TTL wait.
 *
 * NOTE: when unlinked, the return value is byte-identical to
 * `path.join(directory, '.swarm')`, so callers are unaffected.
 *
 * Memory occupies `<result>/memory/`. The caller (`resolveVettedMemoryRoot`)
 * appends `memory` to namespace within the cohort container.
 */
export function resolveMemoryStoreDir(directory: string): string {
	const localSwarm = path.join(directory, '.swarm');
	// The physical target can change while the host keeps the alias string.
	// Fresh identity prevents a retargeted alias from sharing a project cache
	// entry with its former target.
	const cacheKey = canonicalRootKeyFresh(directory);
	const now = Date.now();

	const cached = _resolutionCache.get(cacheKey);
	const currentStat = pointerStatFingerprint(directory);
	if (cached && now < cached.expires && cached.pointerStat === currentStat) {
		return cached.linkDir ?? localSwarm;
	}

	let linkDir: string | null = null;
	try {
		const pointer = readMemoryLinkPointer(directory);
		if (pointer) {
			// path.resolve() canonicalizes — callers never operate on non-canonical
			// paths. Traversal safety is enforced by sanitizeLinkId on the linkId.
			linkDir = path.resolve(resolveLinkDir(pointer.linkId));
		}
	} catch {
		linkDir = null;
	}

	// FIFO eviction (Invariant 8) before inserting a fresh key.
	if (
		!_resolutionCache.has(cacheKey) &&
		_resolutionCache.size >= MAX_CACHE_ENTRIES
	) {
		const oldest = _resolutionCache.keys().next().value;
		if (oldest !== undefined) _resolutionCache.delete(oldest);
	}
	_resolutionCache.set(cacheKey, {
		linkDir,
		expires: now + CACHE_TTL_MS,
		pointerStat: currentStat,
	});

	return linkDir ?? localSwarm;
}

/** Drop cached resolution(s). Pass a directory to invalidate one, omit for all. */
export function invalidateMemoryStoreDirCache(directory?: string): void {
	if (directory === undefined) {
		_resolutionCache.clear();
		return;
	}
	_resolutionCache.delete(canonicalRootKeyFresh(directory));
}

/** True when the worktree currently redirects to a shared cohort store. */
export function isMemoryLinked(directory: string): boolean {
	return readMemoryLinkPointer(directory) !== null;
}

/** Surface an orphaned local memory store if the link pointer is active. */
export function warnIfMemoryOrphaned(directory: string): void {
	const pointer = readMemoryLinkPointer(directory);
	if (!pointer) return;
	const localMemoryDb = path.join(directory, '.swarm', 'memory', 'memory.db');
	const localJsonl = path.join(directory, '.swarm', 'memory', 'memories.jsonl');
	if (existsSync(localMemoryDb) || existsSync(localJsonl)) {
		warn(
			'[memory-link] local memory store is orphaned by cohort link — run `/swarm memory unlink` to recover it or delete the local files',
			{ directory, linkId: pointer.linkId },
		);
	}
}

// ============================================================================
// DI seam (mirrors the codebase convention for bounded test isolation)
// ============================================================================

export const _internals = {
	resolveMemoryStoreDir,
	readMemoryLinkPointer,
	writeMemoryLinkPointer,
	removeMemoryLinkPointer,
	invalidateMemoryStoreDirCache,
	resolveLinkDir,
	resolveLinkBaseDir,
	sanitizeLinkId,
	pointerStatFingerprint,
};

// Re-exported so callers (e.g. the status service) can resolve the cohort
// container directory without depending on knowledge-link.ts directly.
export { resolveLinkDir, resolveLinkBaseDir, sanitizeLinkId };
