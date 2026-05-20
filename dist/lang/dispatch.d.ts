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
import type { LanguageBackend } from './backend';
import './backends';
import { detectProjectLanguages } from './detector';
declare const _internals: {
    detectProjectLanguages: typeof detectProjectLanguages;
    cacheCapacity: number;
};
export { _internals };
/**
 * Pick the most appropriate `LanguageBackend` for `dir`. Walks up to find
 * the manifest root, detects languages there, returns the highest-tier
 * backend (with the default backend synthesized for ids that have no
 * registered override). Returns null if no language is detected.
 *
 * The dispatch is cached by `(manifestRoot, manifestHash)`; cache entries
 * are invalidated automatically when any manifest's size or mtime changes.
 */
export declare function pickBackend(dir: string): Promise<LanguageBackend | null>;
/**
 * Return the ranked language profile list `pickBackend` last detected for
 * `dir`. Used by `buildProjectContext` to populate
 * `PROJECT_CONTEXT_SECONDARY_LANGUAGES` without re-running
 * `detectProjectLanguages`. Returns an empty array when no cached entry
 * matches (caller should invoke `pickBackend(dir)` first to warm the
 * cache).
 */
export declare function pickedProfiles(dir: string): ReadonlyArray<{
    id: string;
}>;
/**
 * Test-only: clear the dispatch cache. Production code should never call
 * this — the cache is invalidated automatically by manifest hashes.
 */
export declare function clearDispatchCache(): void;
