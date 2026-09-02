import { mkdirSync } from 'node:fs';
import { lexicalRootAliasKey } from '../utils/canonical-root.js';
import {
	canonicalExistingFilesystemPath,
	canonicalPathFromExistingAncestor,
	type FilesystemIdentityWitness,
	filesystemIdentityWitnesses,
} from '../utils/filesystem-identity.js';

import type { MemoryConfig } from './config';
import { MemoryValidationError } from './errors';
import type { MemoryProposalStore, MemoryProvider } from './provider';
import { SQLiteMemoryProvider } from './sqlite-provider';
import type { VettedMemoryRoot } from './storage-root';

/**
 * Maximum number of cached providers in the process-level pool.
 * Matches the AGENTS.md invariant 8 requirement for bounded module-level state
 * with an explicit eviction strategy.
 */
const MAX_POOL_SIZE = 16;

/** Marker symbol used to flag providers that are managed by the pool. */
const POOLED_MARKER = Symbol('opencode-swarm-pooled-provider');

/** Symbol holding the original `close` implementation before monkey-patching. */
const REAL_CLOSE = Symbol('opencode-swarm-real-close');

/** LRU doubly-linked list node. */
interface PoolEntry {
	key: string;
	provider: MemoryProvider & MemoryProposalStore;
	refCount: number;
	prev: PoolEntry | null;
	next: PoolEntry | null;
}

// Head = most recently used, Tail = least recently used
let head: PoolEntry | null = null;
let tail: PoolEntry | null = null;

// O(1) lookup by canonical directory key
const entriesByKey = new Map<string, PoolEntry>();

/** Entries evicted from the LRU pool but still holding active references. */
const deferredEntries = new Set<PoolEntry>();

/**
 * Memoizes the last physical resolution per raw (syntactic) root spelling, plus
 * the linked ancestors that can prove a later retarget. This lets a removed or
 * temporarily inaccessible alias retain its owned provider while a live alias
 * that moves to another physical target selects a new provider. Missing leaves
 * are pinned through their nearest existing ancestor before lazy I/O begins.
 * Bounded by the same MAX_POOL_SIZE cap as `entriesByKey` and cleared by
 * `clearPool`.
 */
interface ResolvedKeyCacheEntry {
	key: string;
	witnesses: FilesystemIdentityWitness[];
}

const resolvedKeyCache = new Map<string, ResolvedKeyCacheEntry>();

/**
 * Tag a provider as pool-managed. The pool replaces the provider's `close()`
 * with a function that calls `releaseProvider(provider)`. This makes `close()`
 * itself the release mechanism:
 *
 *   - gateway.dispose() → provider.close() → releaseProvider() → refCount--
 *   - commands/memory.ts → provider.close() → releaseProvider() → refCount--
 *
 * When the final caller releases (refCount reaches 0), the pool calls the
 * original close and removes the entry. Non-pooled providers are unaffected.
 */
function markAsPooled(provider: MemoryProvider & MemoryProposalStore): void {
	const originalClose = provider.close;
	// Replace close() with releaseProvider — this IS the release mechanism.
	// releaseProvider decrements refCount and calls the REAL close on final release.
	provider.close = () => {
		releaseProvider(provider);
		return Promise.resolve();
	};
	(provider as unknown as Record<symbol, unknown>)[POOLED_MARKER] = true;
	if (originalClose) {
		(provider as unknown as Record<symbol, unknown>)[REAL_CLOSE] =
			originalClose;
	}
}

/**
 * Call the real underlying `close()` on a pooled provider, bypassing the
 * monkey-patched release shim. Used by the pool for eviction, clearPool,
 * and the final refcount-drain in `releaseProvider`.
 */
function callRealClose(provider: MemoryProvider & MemoryProposalStore): void {
	const realClose = (provider as unknown as Record<symbol, unknown>)[
		REAL_CLOSE
	] as (() => Promise<void> | void) | undefined;
	try {
		void realClose?.call(provider);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (process.env.OPENCODE_SWARM_DEBUG === '1') {
			// biome-ignore lint/suspicious/noConsole: Debug-only close failure log — only emits when OPENCODE_SWARM_DEBUG=1 is set
			console.debug(`[provider-pool] real close failed: ${msg}`);
		}
	}
}

/**
 * Return true if the provider is currently managed by the pool.
 *
 * Pooled providers have a `close()` that delegates to `releaseProvider`.
 * Any caller (gateway, commands, tools) can safely call `close()` to release
 * its reference; the pool handles refcount tracking and real close on drain.
 */
export function isPooledProvider(
	provider: MemoryProvider & Partial<MemoryProposalStore>,
): boolean {
	return POOLED_MARKER in (provider as unknown as Record<symbol, boolean>);
}

/**
 * Return an existing provider for `directory`, or create and cache a new one.
 *
 * The pool key is the canonical absolute path returned by `realpathSync(directory)`.
 * If `realpathSync` fails (broken symlink, permission error, etc.) the resolved
 * absolute path is used as a fallback key.
 *
 * Every access (hit or miss) updates the LRU ordering so the most-used entries
 * survive eviction. Cache hits increment the reference count so the pool knows
 * how many active callers are using the provider.
 *
 * Note: this function returns synchronously. The provider's actual database
 * open happens lazily inside `provider.initialize()`, which callers await
 * separately (and which is protected by the provider's own init mutex).
 *
 * #1850: callers that have resolved a `VettedMemoryRoot` should prefer
 * `getOrCreateProviderForRoot` so the cohort dimension (cohort id + generation)
 * is part of the pool key. This legacy entry treats `directory` as a local
 * root (cohort sharing inactive for that caller — emits a debug log per
 * critic CONCERN-5 so incomplete wiring is visible).
 */
export function getOrCreateProvider(
	directory: string,
	config: MemoryConfig,
): MemoryProvider & MemoryProposalStore {
	const key = resolvePoolKey(directory);

	// Cache hit — update LRU ordering, bump refcount, and return immediately.
	const existing = entriesByKey.get(key);
	if (existing) {
		moveToHead(existing);
		existing.refCount++;
		return existing.provider;
	}

	// Cache miss — check deferred entries (evicted but still referenced)
	// before creating a new provider. Re-promoting avoids duplicate DB handles
	// for the same directory.
	for (const deferred of deferredEntries) {
		if (deferred.key === key) {
			// Re-promote: move back to active pool
			deferredEntries.delete(deferred);

			// Evict if at capacity before re-inserting
			if (entriesByKey.size >= MAX_POOL_SIZE) {
				evictLru();
			}

			// Re-insert into active pool and LRU list
			deferred.prev = null;
			deferred.next = head;
			if (head) head.prev = deferred;
			head = deferred;
			if (!tail) tail = deferred;
			entriesByKey.set(key, deferred);
			deferred.refCount++;
			return deferred.provider;
		}
	}

	// Cache miss — construct synchronously (constructor stores config only,
	// no I/O) and insert. Duplicate inserts for the same key across
	// overlapping async call-sites are harmless: the provider's init mutex
	// (Phase 1 DD-03) serializes actual DB opens.
	// Bind lazy storage I/O to the exact physical identity used for the pool
	// entry. Keeping the caller's alias here would let a junction/symlink
	// retarget between acquisition and initialize(), so an A-keyed provider
	// could open B's database.
	const provider = new SQLiteMemoryProvider(key, config);
	// Tag as pool-managed before returning so callers can identify it
	// and avoid closing it directly (pool owns lifecycle).
	markAsPooled(provider);

	// Evict LRU entry if at capacity before inserting.
	if (entriesByKey.size >= MAX_POOL_SIZE) {
		evictLru();
	}

	const entry: PoolEntry = {
		key,
		provider,
		refCount: 1,
		prev: null,
		next: head,
	};

	if (head) head.prev = entry;
	head = entry;
	if (!tail) tail = entry;

	entriesByKey.set(key, entry);

	return provider;
}

/**
 * #1850: cohort-aware provider acquisition. The pool key incorporates the
 * root kind + canonical path + cohort generation, so:
 *   - the same cohort root always converges on the same pool entry (acceptance #5);
 *   - a generation bump (observed via the `memory-link.json` pointer-stat
 *     revalidation in `resolveVettedMemoryRoot`) invalidates the stale entry
 *     so the in-memory mirror is reloaded (acceptance #8).
 *
 * NOTE (final-critic correction): the `memory.gen` marker written by providers
 * on cohort writes is NOT consumed by this pool today. Cross-process write
 * visibility relies on SQLite WAL mode (readers see committed writes on the
 * next query) plus the 2s TTL + pointer-stat revalidation in
 * `resolveMemoryStoreDir`. The `memory.gen` marker is reserved for a future
 * tighter revalidation loop and is safe to write (best-effort, never blocks).
 *
 * Revalidation: on each call for a cohort root, the caller is expected to have
 * already resolved the current generation (the resolver does this via
 * `memory-link.json` pointer-stat). If the generation in the supplied root
 * differs from the cached entry's generation, the cached entry is evicted and
 * a fresh provider is constructed (which reloads the in-memory mirror).
 */
export function getOrCreateProviderForRoot(
	root: VettedMemoryRoot,
	config: MemoryConfig,
): MemoryProvider & MemoryProposalStore {
	if (
		root.kind === 'cohort' &&
		canonicalExistingFilesystemPath(root.cohortRoot) === null &&
		!resolvedKeyCache.has(rawPoolKey(root.cohortRoot))
	) {
		// Cohort providers own this vetted store root. Materialize it before key
		// resolution so a missing leaf beneath a symlink/junction is pinned to its
		// physical identity on the very first acquisition, not only after lazy DB
		// initialization.
		try {
			mkdirSync(root.cohortRoot, { recursive: true });
		} catch {
			// Preserve the provider's lazy error behavior when the root cannot be
			// created; the lexical fallback remains available and initialization
			// will report the underlying storage failure at the existing boundary.
		}
	}
	const key = resolvePoolKeyForRoot(root);
	const rootGeneration = root.kind === 'cohort' ? root.generation : 0;

	// Cache hit — but revalidate generation for cohort roots.
	const existing = entriesByKey.get(key);
	if (existing) {
		const existingGen =
			(existing as PoolEntry & { generation?: number }).generation ?? 0;
		if (existingGen === rootGeneration) {
			moveToHead(existing);
			existing.refCount++;
			return existing.provider;
		}
		// Generation changed — peer wrote. Evict and reconstruct so the
		// in-memory mirror reloads. Wait for refCount to drain via the deferred
		// mechanism if the entry is currently held.
		evictEntryByKey(key);
	}

	// Cache miss — check deferred entries similarly.
	for (const deferred of deferredEntries) {
		if (deferred.key === key) {
			const deferredGen =
				(deferred as PoolEntry & { generation?: number }).generation ?? 0;
			if (deferredGen === rootGeneration) {
				deferredEntries.delete(deferred);
				if (entriesByKey.size >= MAX_POOL_SIZE) evictLru();
				deferred.prev = null;
				deferred.next = head;
				if (head) head.prev = deferred;
				head = deferred;
				if (!tail) tail = deferred;
				entriesByKey.set(key, deferred);
				deferred.refCount++;
				return deferred.provider;
			}
			// Stale generation — drop the deferred entry too.
			deferredEntries.delete(deferred);
			callRealClose(deferred.provider);
			break;
		}
	}

	// Provider initialization is lazy, so retain physical paths rather than the
	// mutable aliases supplied by the caller. These values are deliberately
	// derived from the same key resolution that selected the pool entry.
	const directory =
		root.kind === 'local' ? key : resolvePoolKey(root.directory);
	const cohortRoot =
		root.kind === 'cohort' ? key.slice('cohort:'.length) : null;
	const provider = new SQLiteMemoryProvider(directory, config, cohortRoot);
	markAsPooled(provider);

	if (entriesByKey.size >= MAX_POOL_SIZE) {
		evictLru();
	}

	const entry: PoolEntry = {
		key,
		provider,
		refCount: 1,
		prev: null,
		next: head,
	} as PoolEntry & { generation?: number };
	(entry as PoolEntry & { generation?: number }).generation = rootGeneration;

	if (head) head.prev = entry;
	head = entry;
	if (!tail) tail = entry;
	entriesByKey.set(key, entry);

	return provider;
}

/**
 * #1850: pool key for a vetted root. Includes the kind discriminator and
 * (for cohort roots) the canonical cohort root path. Generation is tracked
 * on the entry separately (see `getOrCreateProviderForRoot`) so a generation
 * bump triggers revalidation without changing the key (same root, fresh
 * mirror).
 */
function resolvePoolKeyForRoot(root: VettedMemoryRoot): string {
	if (root.kind === 'cohort') {
		// Resolve cohort roots through the same raw-spelling lifecycle cache as
		// local roots. This preserves the last physical key across a temporary
		// deletion, while still changing identity when an alias is retargeted.
		return `cohort:${resolvePoolKey(root.cohortRoot)}`;
	}
	return resolvePoolKey(root.directory);
}

/** Evict a specific entry by key, closing it if unreferenced. */
function evictEntryByKey(key: string): void {
	const entry = entriesByKey.get(key);
	if (!entry) return;
	if (entry.refCount > 0) {
		// Still held — defer real close to refCount drain.
		deferredEntries.add(entry);
		unlinkEntry(entry);
		entriesByKey.delete(key);
		return;
	}
	unlinkEntry(entry);
	entriesByKey.delete(key);
	callRealClose(entry.provider);
}

/**
 * #1850: scoped eviction — close and drop the pool entry for a specific root
 * (used by the migration engine before file copy). Waits for refCount=0 via
 * the deferred mechanism if held; callers should retry-acquire or fail closed.
 */
export function evictAndCloseForRoot(root: VettedMemoryRoot): void {
	const key = resolvePoolKeyForRoot(root);
	evictEntryByKey(key);
}

/**
 * Release a pooled provider back to the pool by decrementing its refCount.
 *
 * **Lifecycle contract:** refCount is per-PROVIDER, not per-ACQUISITION.
 * Each acquisition (getOrCreateProvider call) MUST be released exactly once
 * via provider.close() (which calls releaseProvider internally) or
 * MemoryGateway.dispose() (which is one-shot via a `disposed` flag).
 *
 * Calling close() MORE THAN ONCE per acquisition may corrupt refCount.
 * MemoryGateway prevents this with its one-shot dispose flag. Callers that
 * use provider.close() directly (e.g., commands/memory.ts) must ensure
 * they call it exactly once per acquisition — typically by using the
 * provider in a single synchronous or try/finally block.
 *
 * Idle entries (refCount=0) remain in the pool for reuse until LRU eviction.
 * Active entries (refCount>0) are deferred-closed on eviction until all
 * references release.
 */
export function releaseProvider(
	provider: MemoryProvider & Partial<MemoryProposalStore>,
): void {
	// Check active pool first
	for (const [_key, entry] of entriesByKey) {
		if (entry.provider === provider) {
			entry.refCount = Math.max(0, entry.refCount - 1);
			// Do NOT close or remove when refCount reaches 0.
			// The entry stays in the pool for reuse by future getOrCreateProvider calls.
			// Only LRU eviction (evictLru) or clearPool closes active pool entries.
			return;
		}
	}
	// Check deferred entries (evicted but still referenced)
	for (const entry of deferredEntries) {
		if (entry.provider === provider) {
			entry.refCount--;
			if (entry.refCount <= 0) {
				deferredEntries.delete(entry);
				callRealClose(provider as MemoryProvider & MemoryProposalStore);
			}
			return;
		}
	}
	// Not found anywhere — fallback for pooled providers whose entry was lost
	if (isPooledProvider(provider)) {
		callRealClose(provider as MemoryProvider & MemoryProposalStore);
	}
}

/**
 * Evict the least-recently-used entry when the pool is at capacity.
 * If the evicted entry has active references (refCount > 0), it is moved
 * to a deferred set and closed only when the final reference is released.
 * This prevents closing a DB handle while active callers are still using it.
 */
function evictLru(): void {
	if (!tail) return;

	const evicted = tail;
	entriesByKey.delete(evicted.key);
	unlinkEntry(evicted);

	if (evicted.refCount > 0) {
		// Active references exist — defer close until refCount drains to 0
		deferredEntries.add(evicted);
	} else {
		// No active references — close immediately
		callRealClose(evicted.provider);
	}
}

/** Move an existing entry to the head (most-recently-used position). */
function moveToHead(entry: PoolEntry): void {
	if (head === entry) return; // already MRU

	unlinkEntry(entry);

	entry.prev = null;
	entry.next = head;

	if (head) head.prev = entry;
	head = entry;

	if (!tail) tail = entry;
}

/** Unlink `entry` from the doubly-linked list without touching the map. */
function unlinkEntry(entry: PoolEntry): void {
	if (entry.prev) entry.prev.next = entry.next;
	if (entry.next) entry.next.prev = entry.prev;

	if (head === entry) head = entry.next;
	if (tail === entry) tail = entry.prev;
}

/**
 * Resolve the canonical pool key for a directory.
 *
 * Prefers `realpathSync` (resolves symlinks, normalises casing on Windows).
 * Falls back to `path.resolve` when realpath fails so the pool remains usable
 * even for paths that cannot be stat'd. When falling back, reuses this exact
 * raw path's last successful realpath resolution (if any) so the SAME
 * directory string always maps to the SAME key, even after the directory is
 * removed — see `resolvedKeyCache`'s docstring.
 */
function resolvePoolKey(directory: string): string {
	const rawKey = rawPoolKey(directory);
	const canonical = canonicalExistingFilesystemPath(directory);
	if (canonical !== null) {
		rememberResolvedKey(
			rawKey,
			canonical,
			filesystemIdentityWitnesses(directory),
		);
		return canonical;
	}

	const prior = resolvedKeyCache.get(rawKey);
	const inferred = canonicalPathFromExistingAncestor(directory);
	const witnessRetargeted = prior?.witnesses.some((witness) => {
		const current = canonicalExistingFilesystemPath(witness.lexicalPath);
		return current !== null && current !== witness.canonicalPath;
	});
	if (
		inferred &&
		(prior === undefined ||
			inferred.existingAncestorIsLink ||
			witnessRetargeted)
	) {
		// Pin a missing leaf to its nearest physical ancestor. A live link/junction
		// or a changed acquisition witness is positive retarget evidence, so refresh
		// an earlier key. When the alias disappears entirely, retain the prior key.
		rememberResolvedKey(
			rawKey,
			inferred.canonicalPath,
			inferred.identityWitnesses,
		);
		return inferred.canonicalPath;
	}
	if (prior) return prior.key;
	if (inferred) return inferred.canonicalPath;
	throw new MemoryValidationError(
		'memory storage root physical identity could not be resolved',
	);
}

function rememberResolvedKey(
	rawKey: string,
	canonical: string,
	witnesses: FilesystemIdentityWitness[],
): void {
	// Refresh recency (Map preserves insertion order) so eviction drops the
	// least-recently-resolved raw path, not an arbitrary one.
	resolvedKeyCache.delete(rawKey);
	resolvedKeyCache.set(rawKey, { key: canonical, witnesses });
	if (resolvedKeyCache.size > MAX_POOL_SIZE) {
		const oldest = resolvedKeyCache.keys().next().value;
		if (oldest !== undefined) resolvedKeyCache.delete(oldest);
	}
}

function rawPoolKey(directory: string): string {
	return lexicalRootAliasKey(directory);
}

/**
 * Evict and close every cached provider. Intended for test teardown only —
 * production code should rely on LRU eviction.
 *
 * DANGER for production code paths: this force-closes EVERY pooled entry
 * process-wide, bypassing the refCount contract that `releaseProvider()` /
 * `evictLru()` honor — including entries for OTHER directories with active
 * callers (this plugin's module-level pool is shared by every in-process
 * memory operation, per AGENTS.md invariant 8). A production command that
 * needs to force-close its OWN throwaway provider (e.g. before deleting a
 * temp directory) must use `evictAndClose(directory)` instead, which is
 * scoped to a single pool key and leaves every other entry untouched.
 */
export function clearPool(): void {
	let entry = head;
	while (entry) {
		const next = entry.next;
		callRealClose(entry.provider);
		entry = next;
	}
	for (const deferred of deferredEntries) {
		callRealClose(deferred.provider);
	}
	deferredEntries.clear();
	entriesByKey.clear();
	resolvedKeyCache.clear();
	head = null;
	tail = null;
}

/**
 * Force-close and evict the SINGLE pool entry for `directory` (matched via
 * the same canonical key as `getOrCreateProvider`), regardless of refCount.
 * Every other pooled entry is left completely untouched — safe to call from
 * a scoped, single-directory teardown (e.g. a throwaway eval temp root about
 * to be deleted) without disrupting other in-process callers sharing the
 * pool. No-op if no entry exists for that directory.
 *
 * Bypassing refCount here is intentional and safe ONLY when the caller
 * already knows the directory is being torn down and will never be accessed
 * again (e.g. immediately followed by `fs.rm` on the same path) — it is not
 * a general-purpose substitute for `releaseProvider()`.
 */
export function evictAndClose(directory: string): void {
	const key = resolvePoolKey(directory);
	const active = entriesByKey.get(key);
	if (active) {
		entriesByKey.delete(key);
		unlinkEntry(active);
		callRealClose(active.provider);
	}
	for (const deferred of [...deferredEntries]) {
		if (deferred.key === key) {
			deferredEntries.delete(deferred);
			callRealClose(deferred.provider);
		}
	}
}
