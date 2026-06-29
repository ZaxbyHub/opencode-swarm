import type { EmbeddingCacheEntry } from '../../../src/memory/embeddings/types';

/**
 * Factory for a fake EmbeddingCacheEntry used in cache-related tests.
 */
export function makeEntry(query: string): EmbeddingCacheEntry {
	return {
		vector: new Float32Array([1, 2, 3]),
		modelVersion: 'test-model:128',
		queryHash: `hash-${query}`,
	};
}
