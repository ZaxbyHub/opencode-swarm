import { beforeEach, describe, expect, test } from 'bun:test';
import { EmbeddingCache } from '../../../src/memory/embeddings/cache';
import type { EmbeddingCacheEntry } from '../../../src/memory/embeddings/types';
import { makeEntry } from './_test-helpers';

describe('EmbeddingCache', () => {
	// -------------------------------------------------------------------------
	// 1. LRU eviction
	// -------------------------------------------------------------------------
	describe('LRU eviction', () => {
		test('inserting a 4th entry evicts the oldest when cacheSize=3', () => {
			const cache = new EmbeddingCache(3);
			cache.set('v1', 'query-a', makeEntry('query-a'));
			cache.set('v1', 'query-b', makeEntry('query-b'));
			cache.set('v1', 'query-c', makeEntry('query-c'));

			expect(cache.size).toBe(3);
			expect(cache.has('v1', 'query-a')).toBe(true);
			expect(cache.has('v1', 'query-b')).toBe(true);
			expect(cache.has('v1', 'query-c')).toBe(true);

			// Insert a 4th — the oldest ('query-a') must be evicted.
			cache.set('v1', 'query-d', makeEntry('query-d'));

			expect(cache.size).toBe(3);
			expect(cache.has('v1', 'query-a')).toBe(false); // evicted
			expect(cache.has('v1', 'query-b')).toBe(true);
			expect(cache.has('v1', 'query-c')).toBe(true);
			expect(cache.has('v1', 'query-d')).toBe(true);
		});

		test('get() promotes an entry to most-recently-used so it survives eviction', () => {
			const cache = new EmbeddingCache(3);
			cache.set('v1', 'query-a', makeEntry('query-a'));
			cache.set('v1', 'query-b', makeEntry('query-b'));
			cache.set('v1', 'query-c', makeEntry('query-c'));

			// Access 'query-a' — it becomes MRU.
			const entry = cache.get('v1', 'query-a');
			expect(entry).not.toBeUndefined();
			expect(entry!.queryHash).toBe('hash-query-a');

			// Insert 'query-d'; 'query-b' (the next oldest) should be evicted, NOT 'query-a'.
			cache.set('v1', 'query-d', makeEntry('query-d'));

			expect(cache.size).toBe(3);
			expect(cache.has('v1', 'query-a')).toBe(true); // survived
			expect(cache.has('v1', 'query-b')).toBe(false); // evicted
			expect(cache.has('v1', 'query-c')).toBe(true);
			expect(cache.has('v1', 'query-d')).toBe(true);
		});

		test('updating an existing key does not grow the cache or cause eviction', () => {
			const cache = new EmbeddingCache(3);
			cache.set('v1', 'query-a', makeEntry('query-a'));
			cache.set('v1', 'query-b', makeEntry('query-b'));
			cache.set('v1', 'query-c', makeEntry('query-c'));

			// Re-inserting the same key just updates it (and promotes it to MRU).
			cache.set('v1', 'query-a', makeEntry('query-a-updated'));

			expect(cache.size).toBe(3); // still 3, no eviction
			expect(cache.has('v1', 'query-a')).toBe(true);
			expect(cache.has('v1', 'query-b')).toBe(true);
			expect(cache.has('v1', 'query-c')).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// 2. Basic API: get / set / has / clear / size
	// -------------------------------------------------------------------------
	describe('basic API', () => {
		test('get() returns undefined for a key that does not exist', () => {
			const cache = new EmbeddingCache(10);
			expect(cache.get('v1', 'never-set')).toBeUndefined();
		});

		test('set() then get() returns the stored entry', () => {
			const cache = new EmbeddingCache(10);
			const entry = makeEntry('my-query');
			cache.set('v1', 'my-query', entry);
			const retrieved = cache.get('v1', 'my-query');
			expect(retrieved).not.toBeUndefined();
			expect(retrieved!.queryHash).toBe('hash-my-query');
			expect(retrieved!.modelVersion).toBe('test-model:128');
		});

		test('has() returns true for an existing key and false for a missing key', () => {
			const cache = new EmbeddingCache(10);
			cache.set('v1', 'exists', makeEntry('exists'));
			expect(cache.has('v1', 'exists')).toBe(true);
			expect(cache.has('v1', 'does-not-exist')).toBe(false);
		});

		test('size reflects the number of entries', () => {
			const cache = new EmbeddingCache(10);
			expect(cache.size).toBe(0);
			cache.set('v1', 'a', makeEntry('a'));
			expect(cache.size).toBe(1);
			cache.set('v1', 'b', makeEntry('b'));
			expect(cache.size).toBe(2);
			cache.clear();
			expect(cache.size).toBe(0);
		});

		test('clear() empties the cache', () => {
			const cache = new EmbeddingCache(10);
			cache.set('v1', 'x', makeEntry('x'));
			cache.set('v1', 'y', makeEntry('y'));
			expect(cache.size).toBe(2);

			cache.clear();

			expect(cache.size).toBe(0);
			expect(cache.has('v1', 'x')).toBe(false);
			expect(cache.has('v1', 'y')).toBe(false);
			expect(cache.get('v1', 'x')).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// 3. Composite key collision — (modelVersion, normalizedQuery) is unique
	// -------------------------------------------------------------------------
	describe('composite key uniqueness', () => {
		test('same query text but different modelVersion are distinct entries', () => {
			const cache = new EmbeddingCache(10);
			const entryV1 = makeEntry('same-query');
			entryV1.modelVersion = 'model-v1';
			const entryV2 = makeEntry('same-query');
			entryV2.modelVersion = 'model-v2';

			cache.set('model-v1', 'same-query', entryV1);
			cache.set('model-v2', 'same-query', entryV2);

			expect(cache.size).toBe(2);
			expect(cache.has('model-v1', 'same-query')).toBe(true);
			expect(cache.has('model-v2', 'same-query')).toBe(true);

			// Each retrieves its own entry
			const r1 = cache.get('model-v1', 'same-query');
			const r2 = cache.get('model-v2', 'same-query');
			expect(r1!.modelVersion).toBe('model-v1');
			expect(r2!.modelVersion).toBe('model-v2');
		});

		test('same modelVersion but different query text are distinct entries', () => {
			const cache = new EmbeddingCache(10);
			cache.set('v1', 'alpha', makeEntry('alpha'));
			cache.set('v1', 'beta', makeEntry('beta'));

			expect(cache.size).toBe(2);
			expect(cache.has('v1', 'alpha')).toBe(true);
			expect(cache.has('v1', 'beta')).toBe(true);
			expect(cache.get('v1', 'alpha')!.queryHash).toBe('hash-alpha');
			expect(cache.get('v1', 'beta')!.queryHash).toBe('hash-beta');
		});
	});

	// -------------------------------------------------------------------------
	// 4. Per-session isolation — two instances share no state
	// -------------------------------------------------------------------------
	describe('per-session isolation', () => {
		test('two EmbeddingCache instances do not share state', () => {
			const cacheA = new EmbeddingCache(10);
			const cacheB = new EmbeddingCache(10);

			cacheA.set('v1', 'only-in-a', makeEntry('only-in-a'));
			cacheB.set('v1', 'only-in-b', makeEntry('only-in-b'));

			expect(cacheA.size).toBe(1);
			expect(cacheB.size).toBe(1);
			expect(cacheA.has('v1', 'only-in-a')).toBe(true);
			expect(cacheA.has('v1', 'only-in-b')).toBe(false);
			expect(cacheB.has('v1', 'only-in-a')).toBe(false);
			expect(cacheB.has('v1', 'only-in-b')).toBe(true);

			// Evicting from A does not affect B
			for (let i = 0; i < 12; i++) {
				cacheA.set('v1', `evict-${i}`, makeEntry(`evict-${i}`));
			}
			expect(cacheA.has('v1', 'only-in-a')).toBe(false);
			expect(cacheB.has('v1', 'only-in-b')).toBe(true); // B untouched
			expect(cacheB.size).toBe(1);
		});

		test('no module-level mutable state', () => {
			// Two independent constructor calls must each get a fresh internal Map.
			const cache1 = new EmbeddingCache(5);
			const cache2 = new EmbeddingCache(5);
			cache1.set('v1', 'in-cache1', makeEntry('in-cache1'));
			// cache2 was never written to — its map is independent
			expect(cache2.get('v1', 'in-cache1')).toBeUndefined();
			expect(cache2.size).toBe(0);
		});
	});

	// -------------------------------------------------------------------------
	// 5. Store-reset invalidation (FR-008)
	// -------------------------------------------------------------------------
	describe('store-reset invalidation (FR-008)', () => {
		test('clear() empties the cache: size→0, has()→false for all prior entries', () => {
			const cache = new EmbeddingCache(256);
			cache.set('v1', 'a', makeEntry('a'));
			cache.set('v1', 'b', makeEntry('b'));
			cache.set('v1', 'c', makeEntry('c'));
			expect(cache.size).toBe(3);

			cache.clear();

			expect(cache.size).toBe(0);
			expect(cache.has('v1', 'a')).toBe(false);
			expect(cache.has('v1', 'b')).toBe(false);
			expect(cache.has('v1', 'c')).toBe(false);
			expect(cache.get('v1', 'a')).toBeUndefined();
		});

		test('re-opening a provider (new EmbeddingCache instance) starts with empty cache', () => {
			// Simulate provider close/reopen: new cache instance
			const cacheOne = new EmbeddingCache(256);
			cacheOne.set('v1', 'old-data', makeEntry('old-data'));
			cacheOne.clear();

			const cacheTwo = new EmbeddingCache(256); // fresh instance
			expect(cacheTwo.size).toBe(0);
			expect(cacheTwo.has('v1', 'old-data')).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// 6. Adversarial inputs
	// -------------------------------------------------------------------------
	describe('adversarial inputs', () => {
		test('empty-string query is valid and distinct from " " after normalization', () => {
			const cache = new EmbeddingCache(10);
			cache.set('v1', '', makeEntry('empty'));
			cache.set('v1', '   ', makeEntry('spaces'));

			// Both normalize to "" so they collide on the same cache slot.
			// After normalization, '' and '   ' are the same key.
			expect(cache.size).toBe(1); // second set overwrote first
			expect(cache.has('v1', '')).toBe(true);
			expect(cache.has('v1', '   ')).toBe(true); // same normalized key
		});

		test('query containing the NUL (\\0) separator character — no key corruption', () => {
			const cache = new EmbeddingCache(10);
			const entry = makeEntry('query\0with\0nulls');
			cache.set('v1', 'query\0with\0nulls', entry);

			// The composite key is: "v1\0query\0with\0nulls"
			// A query containing \0 must NOT be confused with a key that uses \0 as the version/query separator.
			// compositeKey builds: `${modelVersion}\0${normalizedQuery}`
			// So a query "a\0b" produces key "v1\0a\0b" — different from "v1\0a" or any other.
			expect(cache.has('v1', 'query\0with\0nulls')).toBe(true);
			expect(cache.has('v1', 'query\0with\0null')).toBe(false); // suffix missing
			expect(cache.has('v1', 'query\0with')).toBe(false);
			expect(cache.size).toBe(1);
		});

		test('cacheSize=1: every 2nd insert evicts the first', () => {
			const cache = new EmbeddingCache(1);
			cache.set('v1', 'first', makeEntry('first'));
			expect(cache.has('v1', 'first')).toBe(true);

			cache.set('v1', 'second', makeEntry('second'));
			expect(cache.size).toBe(1);
			expect(cache.has('v1', 'first')).toBe(false); // evicted
			expect(cache.has('v1', 'second')).toBe(true);

			cache.set('v1', 'third', makeEntry('third'));
			expect(cache.size).toBe(1);
			expect(cache.has('v1', 'second')).toBe(false); // evicted
			expect(cache.has('v1', 'third')).toBe(true);
		});

		test('cacheSize=0: correct behaviour is that inserts are rejected (no room ever)', () => {
			// When maxSize=0 the cache has no capacity.
			// The expected correct behaviour is that set() skips insertion
			// when maxSize=0 (no eviction can free a slot because cache is empty).
			// NOTE: current source-code has a bug — set() unconditionally calls
			// this.cache.set() after the if/else-if, so entry IS inserted.
			// This test asserts the correct/intended behaviour.
			const cache = new EmbeddingCache(0);
			cache.set('v1', 'any', makeEntry('any'));
			expect(cache.size).toBe(0); // correct: insertion should be rejected
			expect(cache.has('v1', 'any')).toBe(false);
		});

		test('very large cacheSize is respected (no artificial cap)', () => {
			const cache = new EmbeddingCache(10_000);
			for (let i = 0; i < 100; i++) {
				cache.set('v1', `q-${i}`, makeEntry(`q-${i}`));
			}
			expect(cache.size).toBe(100);
			// First entries still present
			expect(cache.has('v1', 'q-0')).toBe(true);
			expect(cache.has('v1', 'q-99')).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// 7. Query text normalization
	// -------------------------------------------------------------------------
	describe('query text normalization', () => {
		test('"Foo" and "foo" are stored under the same normalized key', () => {
			const cache = new EmbeddingCache(10);
			cache.set('v1', 'Foo', makeEntry('Foo'));

			// "foo" (lowercase) normalizes to same key
			expect(cache.has('v1', 'foo')).toBe(true);
			expect(cache.has('v1', 'FOO')).toBe(true);
			expect(cache.has('v1', '  foo  ')).toBe(true); // trim too

			// Both point to the same slot; second insert updates + promotes
			cache.set('v1', 'foo', makeEntry('foo-updated'));
			expect(cache.size).toBe(1);
			const entry = cache.get('v1', 'Foo');
			expect(entry!.queryHash).toBe('hash-foo-updated');
		});

		test('whitespace is trimmed before key construction', () => {
			const cache = new EmbeddingCache(10);
			cache.set('v1', '  bar  ', makeEntry('bar'));

			expect(cache.has('v1', 'bar')).toBe(true);
			expect(cache.has('v1', '  bar  ')).toBe(true);
			expect(cache.has('v1', 'bar ')).toBe(true);
			expect(cache.has('v1', '  bar')).toBe(true);

			cache.set('v1', 'baz ', makeEntry('baz'));
			expect(cache.size).toBe(2); // 'bar' and 'baz' are distinct after trim

			cache.set('v1', 'baz', makeEntry('baz-updated'));
			expect(cache.size).toBe(2); // updated, not new
		});
	});
});
