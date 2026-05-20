/**
 * Dispatch: pick the right `LanguageBackend` for a directory.
 *
 * `pickBackend(dir)` walks up from `dir` to find the nearest project
 * manifest, runs language detection on that root, and returns the
 * registered (or defaulted) backend for the dominant language. Caches
 * results in a bounded LRU keyed by (dir, manifest-hash) so repeated calls
 * during a session do not re-walk the filesystem.
 *
 * Per the language-agnostic plan, hot-path callers (hooks, tools) wrap
 * this in `withTimeout(200ms)` and fail open on the cache miss; session-
 * start callers use `withTimeout(2000ms)`. Both budgets are caller-set —
 * the dispatch function itself does not impose timeouts.
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
import { detectProjectLanguages } from './detector';
import { LANGUAGE_BACKEND_REGISTRY } from './registry-backend';

const _internals: {
	detectProjectLanguages: typeof detectProjectLanguages;
	cacheCapacity: number;
} = {
	detectProjectLanguages,
	cacheCapacity: 64,
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
const MANIFEST_FILES = [
	'package.json',
	'tsconfig.json',
	'pyproject.toml',
	'setup.py',
	'setup.cfg',
	'requirements.txt',
	'Pipfile',
	'Cargo.toml',
	'go.mod',
	'pom.xml',
	'build.gradle',
	'build.gradle.kts',
	'build.zig',
	'CMakeLists.txt',
	'Makefile',
	'meson.build',
	'Package.swift',
	'pubspec.yaml',
	'Gemfile',
	'composer.json',
] as const;

/**
 * Compute a stable hash of all manifest file contents present in `dir`.
 * Returns the empty string if none are present.
 *
 * Combines size + mtimeMs + inode. inode catches atomic-replace edits
 * (same size, same mtime granularity) which size+mtime alone misses on
 * filesystems with second-level mtime rounding (HFS+, some Docker overlay
 * layouts). On Windows, fs.statSync returns a synthesized ino that is
 * stable per-handle within a process — sufficient for cache invalidation.
 */
const _MANIFEST_SET: Set<string> = new Set(MANIFEST_FILES);

/**
 * List a directory's entries safely, returning an empty Set on error
 * (permission denied, ENOENT, etc.). Wrapped to avoid the cost of throw-
 * and-catch when the caller iterates many directories.
 */
function safeReaddirSet(dir: string): Set<string> {
	try {
		return new Set(fs.readdirSync(dir));
	} catch {
		return new Set();
	}
}

function manifestHash(dir: string): string {
	// One readdir call + Set intersection beats 20 sequential fs.statSync
	// calls. On Windows under corporate antivirus each individual stat can
	// take 5-20ms; the previous all-stats loop was the dominant Windows
	// cost on repro-704 T1.
	const entries = safeReaddirSet(dir);
	if (entries.size === 0) return '';
	const parts: string[] = [];
	for (const name of MANIFEST_FILES) {
		if (!entries.has(name)) continue;
		try {
			const stat = fs.statSync(path.join(dir, name));
			parts.push(`${name}:${stat.size}:${stat.mtimeMs}:${stat.ino}`);
		} catch {
			// race with concurrent delete — skip
		}
	}
	return parts.join('|');
}

/**
 * Cache of input-dir → resolved-manifest-root. Skips the upward walk on
 * repeated `pickBackend(dir)` calls with the same dir, which the
 * adversarial review flagged as wasted work — the entry cache hash check
 * doesn't help if findManifestRoot itself takes N readdir calls.
 *
 * Cleared by `clearDispatchCache` along with the main cache.
 */
const manifestRootCache: Map<string, string> = new Map();

/**
 * Walk up from `start` until a directory containing any of MANIFEST_FILES
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
 */
function findManifestRoot(start: string): string {
	const resolved = path.resolve(start);
	const cached = manifestRootCache.get(resolved);
	if (cached !== undefined) return cached;
	let cur = resolved;
	for (let i = 0; i < 32; i++) {
		const entries = safeReaddirSet(cur);
		if (entries.size > 0) {
			for (const name of MANIFEST_FILES) {
				if (entries.has(name)) {
					manifestRootCache.set(resolved, cur);
					return cur;
				}
			}
			// .git boundary: stop the walk at the enclosing git root so we
			// don't leak into ancestor projects.
			if (entries.has('.git')) {
				manifestRootCache.set(resolved, cur);
				return cur;
			}
		}
		const parent = path.dirname(cur);
		if (parent === cur) break; // reached filesystem root
		cur = parent;
	}
	manifestRootCache.set(resolved, start);
	return start;
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
): Promise<LanguageBackend | null> {
	const root = findManifestRoot(dir);
	const hash = manifestHash(root);
	const cacheKey = root;
	const cached = cache.get(cacheKey);
	if (cached && cached.hash === hash) {
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
		return null;
	}

	const profiles = await _internals.detectProjectLanguages(root);
	if (profiles.length === 0) {
		cache.set(cacheKey, {
			hash,
			backend: null,
			profiles: [],
			insertOrder: insertCounter++,
		});
		evictIfNeeded();
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
	const root = findManifestRoot(dir);
	const cached = cache.get(root);
	return cached?.profiles ?? [];
}

/**
 * Test-only: clear the dispatch cache. Production code should never call
 * this — the cache is invalidated automatically by manifest hashes.
 */
export function clearDispatchCache(): void {
	cache.clear();
	manifestRootCache.clear();
	insertCounter = 0;
}
