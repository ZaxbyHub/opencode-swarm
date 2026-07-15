/**
 * Knowledge "link" resolution for the opencode-swarm knowledge system.
 *
 * Problem: the swarm knowledge tier is rooted at `<directory>/.swarm/`, where
 * `directory` is `ctx.directory`. When several swarms run in separate git
 * worktrees of the same repository, each worktree has its own `.swarm/` and
 * therefore its own isolated knowledge store — lessons one swarm learns are
 * invisible to the others. The hive tier is the opposite extreme: global to
 * EVERY project on the machine.
 *
 * A "link" ties multiple worktrees (or several deliberately "similar" repos)
 * to one shared knowledge store that sits between the per-worktree swarm tier
 * and the global hive tier. Membership is declared by an opt-in pointer file at
 * `<directory>/.swarm/link.json`. When that pointer is active, the swarm
 * knowledge *family* (store, events, rejected, retractions, counters,
 * quarantine, unactionable) redirects from `<directory>/.swarm` to a shared
 * link directory in the platform data dir — co-located with the hive store.
 *
 * Intentionally NOT redirected (stays per-worktree): `.knowledge-shown.json`
 * (phase-keyed, session-local outcome bookkeeping), `plan.json`, evidence, and
 * session state. Only id-keyed / append-only knowledge data is pooled.
 *
 * This module is self-contained (node builtins + the atomic-write helper only)
 * so it can be imported by knowledge-store.ts, knowledge-events.ts, and
 * knowledge-validator.ts without coupling to the heavily test-mocked store
 * module and without import cycles.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile } from '../evidence/task-file.js';
import { warn } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/** On-disk pointer at `<directory>/.swarm/link.json`. */
export interface LinkPointer {
	/** Pointer schema version. v1 pointers stay valid; v2 carries cohort metadata. */
	version: 1 | 2;
	/** Path-safe identifier of the shared store (projectHash or sanitized name). */
	linkId: string;
	/** Human-friendly name when the link was created from an explicit name. */
	name?: string;
	/** ISO 8601 creation timestamp. */
	createdAt: string;
	/** How the link was established. */
	source: 'manual' | 'auto';
	// --- v2 additions (optional so v1 pointers remain valid on read) ---
	/** Canonical cohort id from `resolveCohortId` (issue #1846). */
	cohortId?: string;
	/** How the cohort id was derived. */
	identitySource?: 'remote' | 'git-common-dir' | 'path';
	/** True when the cohort id is machine-local (git-common-dir/path fallback). */
	degraded?: boolean;
	/** Deterministic hash of cohort-relevant config (issue #1846 §4). */
	configFingerprint?: string;
	/** Monotonic generation counter, bumped on each link/unlink. Aids cache invalidation. */
	generation?: number;
}

export interface LinkedLocalKnowledgeStatus {
	linked: boolean;
	orphaned: boolean;
	localKnowledgePath: string;
	resolvedKnowledgePath: string;
	reason?:
		| 'not_linked'
		| 'local_missing'
		| 'local_symlink'
		| 'local_regular_file';
}

// ============================================================================
// Constants
// ============================================================================

export const LINK_POINTER_FILENAME = 'link.json';

/** Max length of a single link-id path segment (Windows MAX_PATH friendliness). */
const MAX_LINK_ID_LENGTH = 64;

/**
 * Windows reserved device basenames. A directory literally named after one of
 * these can misbehave with some Win32 APIs, so they are rejected as link ids.
 */
const WINDOWS_RESERVED_NAMES = new Set([
	'con',
	'prn',
	'aux',
	'nul',
	'com0',
	'com1',
	'com2',
	'com3',
	'com4',
	'com5',
	'com6',
	'com7',
	'com8',
	'com9',
	'lpt0',
	'lpt1',
	'lpt2',
	'lpt3',
	'lpt4',
	'lpt5',
	'lpt6',
	'lpt7',
	'lpt8',
	'lpt9',
]);

/**
 * Resolution cache TTL. A pointer rarely changes; within a single phase/operation
 * it never does. Caching avoids a sync `link.json` read on the hot retrieval path
 * (`readKnowledge`, `readKnowledgeCounterRollups`). Cross-process changes are
 * picked up within the TTL; in-process changes call `invalidateKnowledgeStoreDirCache`.
 */
const CACHE_TTL_MS = 2_000;

/** Bounded cache (Invariant 8: module-level state needs explicit FIFO eviction). */
const MAX_CACHE_ENTRIES = 500;

// ============================================================================
// Platform data dir (mirrors resolveHiveKnowledgePath's directory logic so the
// link store sits beside the hive store — duplicated, like knowledge-events.ts,
// to keep this module dependency-light and free of the mocked store module).
// ============================================================================

function resolveDataDir(): string {
	const platform = process.platform;
	// Read $HOME live each call so test redirection via process.env.HOME works.
	const home = process.env.HOME || os.homedir();
	if (platform === 'win32') {
		return path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'Data',
		);
	} else if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'opencode-swarm');
	}
	return path.join(
		process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
		'opencode-swarm',
	);
}

/** Root directory under which all shared link stores live: `<dataDir>/links`. */
export function resolveLinkBaseDir(): string {
	return path.join(resolveDataDir(), 'links');
}

/** Directory of the shared knowledge family for a given link id. */
export function resolveLinkDir(linkId: string): string {
	return path.join(resolveLinkBaseDir(), linkId);
}

// ============================================================================
// Link id sanitization
// ============================================================================

/**
 * Coerce an arbitrary user-supplied name into a single, path-safe directory
 * segment. Returns null when nothing usable remains (caller falls back to the
 * project hash). Lowercased for case-insensitive stability across worktrees.
 */
export function sanitizeLinkId(name: string): string | null {
	if (typeof name !== 'string') return null;
	const cleaned = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, MAX_LINK_ID_LENGTH)
		// slice may have re-exposed a trailing separator — strip again.
		.replace(/[-.]+$/g, '');
	if (cleaned.length === 0) return null;
	// Reject Windows reserved device names (compared on the pre-extension base).
	const base = cleaned.split('.')[0];
	if (WINDOWS_RESERVED_NAMES.has(base)) return null;
	return cleaned;
}

// ============================================================================
// Pointer read / write / remove
// ============================================================================

function resolveLinkPointerPath(directory: string): string {
	return path.join(directory, '.swarm', LINK_POINTER_FILENAME);
}

/**
 * Read and validate the link pointer for a worktree. Null if absent/invalid.
 *
 * Schema-version aware (issue #1846): reads `version` from disk rather than
 * hard-stamping `1`, validates it is a known version, and preserves v2 cohort
 * metadata fields when present. Unknown fields are ignored (forward-compat).
 */
export function readLinkPointer(directory: string): LinkPointer | null {
	const pointerPath = resolveLinkPointerPath(directory);
	if (!existsSync(pointerPath)) return null;
	try {
		const raw = JSON.parse(readFileSync(pointerPath, 'utf-8')) as unknown;
		if (!raw || typeof raw !== 'object') return null;
		const obj = raw as Record<string, unknown>;
		const linkId = obj.linkId;
		if (typeof linkId !== 'string' || linkId.length === 0) return null;
		// Re-sanitize on read: the pointer becomes a path segment, so a hand-edited
		// or corrupted linkId must never reach the filesystem unsanitized.
		const safeId = sanitizeLinkId(linkId);
		if (!safeId) return null;
		// Version: read from disk (do NOT hard-stamp 1). Default missing → 1.
		const rawVersion = obj.version;
		const version: 1 | 2 = rawVersion === 2 ? 2 : 1; // unknown/missing → v1 (lenient, forward-compat)
		return {
			version,
			linkId: safeId,
			name: typeof obj.name === 'string' ? obj.name : undefined,
			createdAt:
				typeof obj.createdAt === 'string'
					? obj.createdAt
					: new Date(0).toISOString(),
			source: obj.source === 'auto' ? 'auto' : 'manual',
			// v2 fields (only set when present and well-typed).
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

export function getLinkedLocalKnowledgeStatus(
	directory: string,
): LinkedLocalKnowledgeStatus {
	const localKnowledgePath = path.join(directory, '.swarm', 'knowledge.jsonl');
	const pointer = readLinkPointer(directory);
	if (!pointer) {
		return {
			linked: false,
			orphaned: false,
			localKnowledgePath,
			resolvedKnowledgePath: localKnowledgePath,
			reason: 'not_linked',
		};
	}

	const resolvedKnowledgePath = path.join(
		path.resolve(resolveLinkDir(pointer.linkId)),
		'knowledge.jsonl',
	);
	if (!existsSync(localKnowledgePath)) {
		return {
			linked: true,
			orphaned: false,
			localKnowledgePath,
			resolvedKnowledgePath,
			reason: 'local_missing',
		};
	}

	try {
		const stat = lstatSync(localKnowledgePath);
		if (stat.isSymbolicLink()) {
			return {
				linked: true,
				orphaned: false,
				localKnowledgePath,
				resolvedKnowledgePath,
				reason: 'local_symlink',
			};
		}
	} catch {
		return {
			linked: true,
			orphaned: false,
			localKnowledgePath,
			resolvedKnowledgePath,
			reason: 'local_missing',
		};
	}

	return {
		linked: true,
		orphaned: true,
		localKnowledgePath,
		resolvedKnowledgePath,
		reason: 'local_regular_file',
	};
}

/** Write the link pointer atomically and invalidate the resolution cache. */
export async function writeLinkPointer(
	directory: string,
	pointer: LinkPointer,
): Promise<void> {
	const swarmDir = path.join(directory, '.swarm');
	mkdirSync(swarmDir, { recursive: true });
	const pointerPath = resolveLinkPointerPath(directory);
	await atomicWriteFile(pointerPath, JSON.stringify(pointer, null, 2));
	invalidateKnowledgeStoreDirCache(directory);
}

/** Remove the link pointer (idempotent) and invalidate the resolution cache. */
export async function removeLinkPointer(directory: string): Promise<void> {
	const pointerPath = resolveLinkPointerPath(directory);
	try {
		rmSync(pointerPath, { force: true });
	} finally {
		invalidateKnowledgeStoreDirCache(directory);
	}
}

// ============================================================================
// Resolution (the seam used by every redirected resolver)
// ============================================================================

interface CacheEntry {
	linkDir: string | null;
	expires: number;
	/**
	 * Pointer-file stat fingerprint (`mtimeMs:ctimeMs:size`) captured when the
	 * entry was created. On a cache hit we re-stat the pointer and compare; a
	 * change means another process wrote/removed the pointer, so we treat the
	 * entry as stale and re-resolve (issue #1846 §2, critic C6/C7).
	 *
	 * `null` means the pointer was absent at cache time (unlinked) — a later
	 * appearance is a change.
	 */
	pointerStat: string | null;
}

const _resolutionCache = new Map<string, CacheEntry>();

/**
 * Build the stat fingerprint for the pointer file. Returns `null` when the
 * pointer is absent (so an absent→present transition is detected as a change).
 * Includes `ctimeMs` because Windows rename preserves `mtimeMs` (mirrors
 * `buildCounterRollupCacheKey` in knowledge-events.ts — critic C7).
 */
function pointerStatFingerprint(directory: string): string | null {
	const pointerPath = resolveLinkPointerPath(directory);
	try {
		const st = statSync(pointerPath);
		return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
	} catch {
		return null;
	}
}

/**
 * Resolve the directory that holds the swarm knowledge family for `directory`.
 *
 * Returns the shared link directory when an active pointer is present, otherwise
 * the local `<directory>/.swarm`. Fail-open: any read/parse error degrades to the
 * local directory, so a corrupt pointer never strands knowledge. Synchronous
 * and cached; on a cache hit a cheap `stat` of the pointer file revalidates
 * cross-process changes so the hot retrieval path stays fast while still
 * observing link/unlink without waiting for the TTL to expire.
 *
 * Cross-process revalidation (issue #1846 §2): on a cache hit we additionally
 * `stat` the pointer file and compare `mtimeMs:ctimeMs:size` to the cached
 * fingerprint. A change (another process wrote/removed the pointer) invalidates
 * the entry, so a stale process observes link/unlink without waiting for the
 * TTL to expire. The TTL remains a backstop. The per-call `stat` is negligible
 * (the pointer is tiny and almost never changes) and is the cost of correct
 * cross-process link/unlink observation.
 *
 * NOTE: when unlinked, the return value is byte-identical to the legacy
 * `path.join(directory, '.swarm')`, so existing callers/tests are unaffected.
 */
export function resolveKnowledgeStoreDir(directory: string): string {
	const localSwarm = path.join(directory, '.swarm');
	const now = Date.now();

	const cached = _resolutionCache.get(directory);
	const currentStat = pointerStatFingerprint(directory);
	if (cached && now < cached.expires && cached.pointerStat === currentStat) {
		return cached.linkDir ?? localSwarm;
	}

	let linkDir: string | null = null;
	try {
		const pointer = readLinkPointer(directory);
		if (pointer) {
			// path.resolve() canonicalizes the shared store path — makes it absolute
			// and collapses any '.'/'..' segments — so callers never operate on a
			// non-canonical path even if the data directory has unexpected shape.
			// NOTE: path.resolve() does NOT resolve symlinks (that needs
			// fs.realpathSync); traversal safety is enforced by sanitizeLinkId on the
			// linkId, not by this call.
			linkDir = path.resolve(resolveLinkDir(pointer.linkId));
			const orphanStatus = getLinkedLocalKnowledgeStatus(directory);
			if (orphanStatus.orphaned) {
				warn(
					'[knowledge-link] local knowledge file is orphaned by link store',
					{
						localKnowledgePath: orphanStatus.localKnowledgePath,
						resolvedKnowledgePath: orphanStatus.resolvedKnowledgePath,
					},
				);
			}
		}
	} catch {
		linkDir = null;
	}

	// FIFO eviction (Invariant 8) before inserting a fresh key.
	if (
		!_resolutionCache.has(directory) &&
		_resolutionCache.size >= MAX_CACHE_ENTRIES
	) {
		const oldest = _resolutionCache.keys().next().value;
		if (oldest !== undefined) _resolutionCache.delete(oldest);
	}
	_resolutionCache.set(directory, {
		linkDir,
		expires: now + CACHE_TTL_MS,
		pointerStat: currentStat,
	});

	return linkDir ?? localSwarm;
}

/** Drop cached resolution(s). Pass a directory to invalidate one, omit for all. */
export function invalidateKnowledgeStoreDirCache(directory?: string): void {
	if (directory === undefined) {
		_resolutionCache.clear();
		return;
	}
	_resolutionCache.delete(directory);
}

/** True when the worktree currently redirects to a shared link store. */
export function isLinked(directory: string): boolean {
	return readLinkPointer(directory) !== null;
}

// ============================================================================
// DI seam (mirrors the codebase convention for bounded test isolation)
// ============================================================================

export const _internals = {
	resolveKnowledgeStoreDir,
	readLinkPointer,
	writeLinkPointer,
	removeLinkPointer,
	getLinkedLocalKnowledgeStatus,
	invalidateKnowledgeStoreDirCache,
	resolveLinkDir,
	resolveLinkBaseDir,
	sanitizeLinkId,
};
