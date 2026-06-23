import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import type { MemoryConfig } from './config';
import type { MemoryProposalStore, MemoryProvider } from './provider';
import { SQLiteMemoryProvider } from './sqlite-provider';

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
	const provider = new SQLiteMemoryProvider(directory, config);
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
 * even for paths that cannot be stat'd.
 */
function resolvePoolKey(directory: string): string {
	try {
		return realpathSync(directory);
	} catch {
		return path.resolve(directory);
	}
}

/**
 * Evict and close every cached provider. Intended for test teardown only —
 * production code should rely on LRU eviction.
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
	head = null;
	tail = null;
}
