/**
 * Dispatch: pick the right `LanguageBackend` for a directory.
 *
 * `pickBackend(dir)` walks up from `dir` to find the nearest project
 * manifest, runs language detection on that root, and returns the
 * registered (or defaulted) backend for the dominant language. Caches
 * results in a bounded LRU keyed by (dir, manifest-hash) so repeated calls
 * during a session do not re-walk the filesystem.
 *
 * Callers supply any timeout policy. Plugin initialization wraps this in
 * `withTimeoutSignal(300ms)` and fails open on timeout; the dispatch function
 * itself does not impose a separate deadline.
 *
 * Invariant 4: this module never writes to `.swarm/`. All caching is
 * in-process. `dir` is treated as caller-supplied and not validated as a
 * project root — callers are responsible for passing the right directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LanguageBackend } from './backend';
// Importing the backends barrel triggers backend registration as a module
// side-effect (see `src/lang/backends/index.ts`). Without this, callers of
// `pickBackend` would get only the default backend even for languages with
// concrete overrides like typescript. The barrel is idempotent.
import './backends';
import { canonicalRootKeyFreshAsync } from '../utils/canonical-root.js';
import { detectProjectLanguages } from './detector';
import { MANIFEST_FILES } from './manifest-files';
import { LANGUAGE_BACKEND_REGISTRY } from './registry-backend';

const _internals: {
	detectProjectLanguages: typeof detectProjectLanguages;
	cacheCapacity: number;
	readonly manifestRootCacheSize: number;
} = {
	detectProjectLanguages,
	cacheCapacity: 64,
	get manifestRootCacheSize() {
		return manifestRootCache.size;
	},
};
export { _internals };

/**
 * Cache key shape: directory absolute path + hash of all detected manifest
 * files' contents. When any manifest file changes, the hash changes and the
 * cache entry is invalidated. Manifests not present contribute nothing.
 *
 * `profiles` is the full ranked list returned by `detectProjectLanguages`
 * (primary first). Cached so `buildProjectContext` does not need to call
 * `detectProjectLanguages` a second time on the critical path.
 */
type CacheValue = {
	hash: string;
	backend: LanguageBackend | null;
	profiles: ReadonlyArray<{ id: string }>;
	insertOrder: number;
};

const cache = new Map<string, CacheValue>();
let insertCounter = 0;

/**
 * Common manifest filenames to hash for cache invalidation. Sourced from
 * every profile's `build.detectFiles` plus the union of common test/lint
 * detect files. Listing them explicitly (rather than re-scanning every
 * profile on every cache check) is cheaper.
 */
/**
 * Compute a stable hash of all manifest file contents present in `dir`.
 * Returns the empty string if none are present.
 *
 * Combines size + mtimeMs + inode. inode catches atomic-replace edits
 * (same size, same mtime granularity) which size+mtime alone misses on
 * filesystems with second-level mtime rounding (HFS+, some Docker overlay
 * layouts). On Windows, async stat returns a synthesized ino that is stable
 * per-handle within a process — sufficient for cache invalidation.
 */
/**
 * List a directory's entries, preserving failure separately from an empty
 * directory so manifest-root walks never cache unverifiable topology.
 */
async function tryReadDirectoryAsync(dir: string): Promise<Set<string> | null> {
	try {
		return new Set(await fs.promises.readdir(dir));
	} catch {
		return null;
	}
}

async function manifestHash(
	dir: string,
	signal?: AbortSignal,
): Promise<string> {
	// Every probe here is asynchronous: this function runs under the plugin
	// initialization withTimeoutSignal boundary, so a slow filesystem must never
	// block the event loop before that boundary can reject and abort the walk.
	const entries = await tryReadDirectoryAsync(dir);
	throwIfAborted(signal);
	if (entries === null || entries.size === 0) return '';
	const names = MANIFEST_FILES.filter((name) => entries.has(name));
	const parts = await Promise.all(
		names.map(async (name) => {
			try {
				const stat = await fs.promises.stat(path.join(dir, name));
				return `${name}:${stat.size}:${stat.mtimeMs}:${stat.ino}`;
			} catch {
				// Race with concurrent delete — omit this manifest. The following
				// call re-observes the current directory topology.
				return null;
			}
		}),
	);
	throwIfAborted(signal);
	return parts.filter((part): part is string => part !== null).join('|');
}

/**
 * Cache of input-dir → resolved-manifest-root plus a bounded directory
 * metadata trace. The trace proves the topology observed during the upward
 * walk is unchanged without re-enumerating directories on warm lookups.
 *
 * Cleared by `clearDispatchCache` along with the main cache.
 */
const MAX_MANIFEST_SEARCH_DEPTH = 32;

type DirectoryFingerprint = {
	directory: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
};

type ManifestRootCacheValue = {
	root: string;
	rootHadManifest: boolean;
	trace: ReadonlyArray<DirectoryFingerprint>;
	insertOrder: number;
};

type ManifestRootResolution = {
	root: string;
	rootHadManifest: boolean;
	key: string;
	trace: ReadonlyArray<DirectoryFingerprint>;
	cacheable: boolean;
};

type DirectoryWalkSnapshot =
	| {
			entries: Set<string>;
			fingerprint: DirectoryFingerprint;
			complete: true;
	  }
	| {
			entries: Set<string> | null;
			complete: false;
	  };

const manifestRootCache: Map<string, ManifestRootCacheValue> = new Map();
let manifestRootInsertCounter = 0;

// `pickedProfiles` runs immediately after `pickBackend` in project-context
// construction. Keep its lookup synchronous and filesystem-free by recording
// the caller's lexical spelling only after dispatch populated the main cache.
const profileCacheKeyByInput = new Map<string, string>();

function cacheProfileKey(input: string, cacheKey: string): void {
	const key = path.resolve(input);
	profileCacheKeyByInput.delete(key);
	profileCacheKeyByInput.set(key, cacheKey);
	while (profileCacheKeyByInput.size > _internals.cacheCapacity) {
		const oldest = profileCacheKeyByInput.keys().next().value;
		if (oldest === undefined) break;
		profileCacheKeyByInput.delete(oldest);
	}
}

async function directoryFingerprint(
	dir: string,
): Promise<DirectoryFingerprint | null> {
	try {
		const stat = await fs.promises.stat(dir);
		if (!stat.isDirectory()) return null;
		return {
			directory: dir,
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
		};
	} catch {
		return null;
	}
}

function fingerprintsMatch(
	expected: DirectoryFingerprint,
	actual: DirectoryFingerprint,
): boolean {
	return (
		expected.dev === actual.dev &&
		expected.ino === actual.ino &&
		expected.size === actual.size &&
		expected.mtimeMs === actual.mtimeMs &&
		expected.ctimeMs === actual.ctimeMs
	);
}

/**
 * Capture a directory listing and stable metadata proof for a root-cache walk.
 * A matching pair of listings brackets the single metadata read: an entry added
 * or removed while enumerating leaves the walk non-cacheable, while the saved
 * fingerprint invalidates a later cache hit after either snapshot completes.
 *
 * Keep this to one asynchronous stat per directory. Cold callers can cross
 * thirty or more directories, where three metadata reads per level can exceed
 * the caller's production startup budget on an antivirus-intercepted
 * filesystem.
 */
async function readDirectoryForManifestWalk(
	dir: string,
): Promise<DirectoryWalkSnapshot> {
	const entries = await tryReadDirectoryAsync(dir);
	const fingerprint = await directoryFingerprint(dir);
	const after = await tryReadDirectoryAsync(dir);
	if (
		entries === null ||
		fingerprint === null ||
		after === null ||
		entries.size !== after.size ||
		[...entries].some((entry) => !after.has(entry))
	) {
		// Never select from the first listing after validation fails: it can
		// name a manifest deleted before the second listing. Continue the
		// bounded ancestor walk from a fresh-safe empty result instead.
		return { entries: null, complete: false };
	}
	return { entries, fingerprint, complete: true };
}

async function isManifestRootCacheEntryValid(
	entry: ManifestRootCacheValue,
): Promise<boolean> {
	for (const fingerprint of entry.trace) {
		const current = await directoryFingerprint(fingerprint.directory);
		if (current === null || !fingerprintsMatch(fingerprint, current)) {
			return false;
		}
	}
	return true;
}

function evictManifestRootCacheIfNeeded(): void {
	if (manifestRootCache.size <= _internals.cacheCapacity) return;
	let oldestKey: string | undefined;
	let oldestOrder = Infinity;
	for (const [key, value] of manifestRootCache) {
		if (value.insertOrder < oldestOrder) {
			oldestKey = key;
			oldestOrder = value.insertOrder;
		}
	}
	if (oldestKey !== undefined) manifestRootCache.delete(oldestKey);
}

function cacheManifestRoot(
	key: string,
	root: string,
	rootHadManifest: boolean,
	trace: ReadonlyArray<DirectoryFingerprint>,
	cacheable: boolean,
	signal?: AbortSignal,
): void {
	if (!cacheable || signal?.aborted) return;
	manifestRootCache.set(key, {
		root,
		rootHadManifest,
		trace,
		insertOrder: manifestRootInsertCounter++,
	});
	evictManifestRootCacheIfNeeded();
}

/**
 * Asynchronously walk up from `start` until a directory containing any of MANIFEST_FILES
 * is found, or we reach the filesystem root. Returns the manifest-bearing
 * directory, or `start` itself if none found.
 *
 * Iterates the SMALL set (MANIFEST_FILES, 20 entries) and probes the
 * directory's readdir result (Set lookup, O(1)). The reverse — iterating
 * the directory entries and checking each against MANIFEST_SET — would
 * be O(N) per level where N is the directory size (can be thousands for
 * crossed-during-walk system dirs like /usr/share).
 *
 * Also stops at `.git` boundary: project roots in real repositories
 * always contain a `.git` directory or file. This prevents the walk
 * from escaping into ancestor directories that happen to contain
 * MANIFEST_FILES (e.g. a monorepo parent's package.json shadowing a
 * sub-project's go.mod). Matches the convention git itself uses for
 * `git rev-parse --show-toplevel`.
 *
 * Linearization: each result reflects the manifest topology observed by its
 * validated listings and fingerprint. A mutation after that observation can
 * only be seen by the next call; filesystem APIs cannot make that later race
 * part of the already-completed lookup.
 */
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason ?? new Error('manifest-root lookup aborted');
	}
}

async function findManifestRoot(
	start: string,
	signal?: AbortSignal,
): Promise<ManifestRootResolution> {
	throwIfAborted(signal);
	const resolved = path.resolve(start);
	const key = await canonicalRootKeyFreshAsync(resolved);
	throwIfAborted(signal);
	const cached = manifestRootCache.get(key);
	if (cached !== undefined) {
		if (await isManifestRootCacheEntryValid(cached)) {
			throwIfAborted(signal);
			return {
				root: cached.root,
				rootHadManifest: cached.rootHadManifest,
				key,
				trace: [],
				cacheable: false,
			};
		}
		manifestRootCache.delete(key);
	}
	let cur = resolved;
	const trace: DirectoryFingerprint[] = [];
	let cacheable = true;
	for (let i = 0; i < MAX_MANIFEST_SEARCH_DEPTH; i++) {
		const snapshot = await readDirectoryForManifestWalk(cur);
		throwIfAborted(signal);
		if (!snapshot.complete) {
			cacheable = false;
		} else {
			trace.push(snapshot.fingerprint);
		}
		const { entries } = snapshot;
		if (entries !== null) {
			if (entries.size > 0) {
				for (const name of MANIFEST_FILES) {
					if (entries.has(name)) {
						return {
							root: cur,
							rootHadManifest: true,
							key,
							trace,
							cacheable,
						};
					}
				}
				// .git boundary: stop the walk at the enclosing git root so we
				// don't leak into ancestor projects.
				if (entries.has('.git')) {
					return {
						root: cur,
						rootHadManifest: false,
						key,
						trace,
						cacheable,
					};
				}
			}
		}
		const parent = path.dirname(cur);
		if (parent === cur) break; // reached filesystem root
		cur = parent;
	}
	return { root: start, rootHadManifest: false, key, trace, cacheable };
}

/**
 * Bounded LRU eviction. Removes the oldest insertion when cache exceeds
 * capacity. Simple insertCounter ordering — sufficient for our use case
 * (per-session, ~tens of distinct directories at most).
 */
function evictIfNeeded(): void {
	if (cache.size <= _internals.cacheCapacity) return;
	let oldestKey: string | undefined;
	let oldestOrder = Infinity;
	for (const [k, v] of cache.entries()) {
		if (v.insertOrder < oldestOrder) {
			oldestOrder = v.insertOrder;
			oldestKey = k;
		}
	}
	if (oldestKey !== undefined) cache.delete(oldestKey);
}

/**
 * Pick the most appropriate `LanguageBackend` for `dir`. Walks up to find
 * the manifest root, detects languages there, returns the highest-tier
 * backend (with the default backend synthesized for ids that have no
 * registered override). Returns null if no language is detected.
 *
 * The dispatch is cached by `(manifestRoot, manifestHash)`; cache entries
 * are invalidated automatically when any manifest's size or mtime changes.
 */
export async function pickBackend(
	dir: string,
	signal?: AbortSignal,
): Promise<LanguageBackend | null> {
	let resolution = await findManifestRoot(dir, signal);
	let { root } = resolution;
	throwIfAborted(signal);
	let hash = await manifestHash(root, signal);
	throwIfAborted(signal);
	if (resolution.rootHadManifest && hash === '') {
		// A warm trace can validate immediately before its selected manifest is
		// deleted. Hashing then observes that deletion, so discard the stale root
		// and re-walk once to select the nearest ancestor visible at that point.
		manifestRootCache.delete(resolution.key);
		resolution = await findManifestRoot(dir, signal);
		root = resolution.root;
		throwIfAborted(signal);
		hash = await manifestHash(root, signal);
		throwIfAborted(signal);
	}
	cacheManifestRoot(
		resolution.key,
		root,
		resolution.rootHadManifest,
		resolution.trace,
		resolution.cacheable,
		signal,
	);
	const cacheKey = await canonicalRootKeyFreshAsync(root);
	throwIfAborted(signal);
	const cached = cache.get(cacheKey);
	if (cached && cached.hash === hash) {
		cacheProfileKey(dir, cacheKey);
		return cached.backend;
	}

	// Short-circuit: no manifests anywhere → no language detection possible.
	// Skip the (potentially expensive) detectProjectLanguages walk and
	// return null immediately. Saves a full repo scan on workspaces that
	// don't have any of the 20 known manifests — including the repro-704
	// T1 fixture which is a synthetic 500-file source-only workspace under
	// a hard 400ms server() deadline.
	if (hash === '') {
		cache.set(cacheKey, {
			hash,
			backend: null,
			profiles: [],
			insertOrder: insertCounter++,
		});
		evictIfNeeded();
		cacheProfileKey(dir, cacheKey);
		return null;
	}

	const profiles = await _internals.detectProjectLanguages(root);
	throwIfAborted(signal);
	if (profiles.length === 0) {
		cache.set(cacheKey, {
			hash,
			backend: null,
			profiles: [],
			insertOrder: insertCounter++,
		});
		evictIfNeeded();
		cacheProfileKey(dir, cacheKey);
		return null;
	}
	// detectProjectLanguages returns profiles tier-sorted (lowest tier first).
	// Pick the first one — caller can list secondary languages via
	// `pickedProfiles(dir)` which exposes the cached ranked list.
	const winner = profiles[0];
	const backend = LANGUAGE_BACKEND_REGISTRY.getOrDefault(winner.id) ?? null;
	cache.set(cacheKey, {
		hash,
		backend,
		profiles: profiles.map((p) => ({ id: p.id })),
		insertOrder: insertCounter++,
	});
	evictIfNeeded();
	cacheProfileKey(dir, cacheKey);
	return backend;
}

/**
 * Return the ranked language profile list `pickBackend` last detected for
 * `dir`. Used by `buildProjectContext` to populate
 * `PROJECT_CONTEXT_SECONDARY_LANGUAGES` without re-running
 * `detectProjectLanguages`. Returns an empty array when no cached entry
 * matches (caller should invoke `pickBackend(dir)` first to warm the
 * cache).
 */
export function pickedProfiles(dir: string): ReadonlyArray<{ id: string }> {
	const cacheKey = profileCacheKeyByInput.get(path.resolve(dir));
	if (cacheKey === undefined) return [];
	const cached = cache.get(cacheKey);
	return cached?.profiles ?? [];
}

/**
 * Test-only: clear the dispatch cache. Production code should never call
 * this — the cache is invalidated automatically by manifest hashes.
 */
export function clearDispatchCache(): void {
	cache.clear();
	manifestRootCache.clear();
	profileCacheKeyByInput.clear();
	insertCounter = 0;
	manifestRootInsertCounter = 0;
}
