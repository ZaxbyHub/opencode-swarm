import type { EmbeddingCacheEntry } from './types';

/**
 * LRU cache for embedding vectors, keyed by (modelVersion, normalizedQuery).
 *
 * Per-session scoped: each instance is independent. No module-level mutable state.
 * Bounded by configurable capacity; evicts least-recently-used entry on overflow.
 */

const DEFAULT_CACHE_SIZE = 256;

function normalizeQuery(query: string): string {
	return query.toLowerCase().trim();
}

function compositeKey(modelVersion: string, normalizedQuery: string): string {
	return `${modelVersion}\0${normalizedQuery}`;
}

export class EmbeddingCache {
	private readonly cache: Map<string, EmbeddingCacheEntry>;
	private readonly maxSize: number;

	constructor(maxSize: number = DEFAULT_CACHE_SIZE) {
		this.maxSize = maxSize;
		this.cache = new Map();
	}

	/** Number of entries currently in the cache. */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Retrieve a cached entry, marking it as recently used.
	 * Returns undefined if the key is not present.
	 */
	get(modelVersion: string, query: string): EmbeddingCacheEntry | undefined {
		const key = compositeKey(modelVersion, normalizeQuery(query));
		const entry = this.cache.get(key);
		if (entry !== undefined) {
			// Re-insert to mark as most-recently-used (Map preserves insertion order).
			this.cache.delete(key);
			this.cache.set(key, entry);
		}
		return entry;
	}

	/**
	 * Store an entry in the cache. Evicts the least-recently-used entry
	 * if the cache is at capacity before inserting.
	 */
	set(modelVersion: string, query: string, entry: EmbeddingCacheEntry): void {
		const key = compositeKey(modelVersion, normalizeQuery(query));

		// If already present, delete first so re-insertion marks it as most-recently-used.
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			// Evict oldest (first) entry.
			const oldestKey = this.cache.keys().next().value;
			if (oldestKey !== undefined) {
				this.cache.delete(oldestKey);
			}
		}

		// Only insert when there is room: either the key was re-inserted (already deleted above)
		// or eviction succeeded (cache was at capacity but is no longer full).
		if (this.cache.size < this.maxSize) {
			this.cache.set(key, entry);
		}
	}

	/**
	 * Check whether an entry exists for the given modelVersion and query,
	 * without altering LRU ordering.
	 */
	has(modelVersion: string, query: string): boolean {
		const key = compositeKey(modelVersion, normalizeQuery(query));
		return this.cache.has(key);
	}

	/** Remove all entries from the cache. Called on store reset / reindex. */
	clear(): void {
		this.cache.clear();
	}
}
