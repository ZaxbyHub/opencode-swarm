export interface EmbeddingProvider {
	/** Compute an embedding vector for a single text. Reject if the provider is unavailable. */
	embed(text: string): Promise<Float32Array>;
	/** Compute embeddings for a batch of texts. Order preserved. Reject if unavailable. */
	embedBatch(texts: string[]): Promise<Float32Array[]>;
	/** The pinned model+dimension version identifier this provider produces. Used for cross-version mismatch detection. */
	readonly modelVersion: string;
	/** The dimension of vectors this provider emits (e.g. 384 for all-MiniLM-L6-v2). */
	readonly dimension: number;
	/** false when the underlying dependency/model is not installed or failed to load — caller must fall back to lexical-only. */
	readonly available: boolean;
}

/** A pinned model+dimension identifier string (e.g. "Xenova/all-MiniLM-L6-v2:384"). */
export type EmbeddingVersion = string;

export interface EmbeddingCacheEntry {
	vector: Float32Array;
	modelVersion: string;
	queryHash: string;
}

export class EmbeddingUnavailableError extends Error {
	constructor(message?: string) {
		super(
			message ??
				'Embedding provider is unavailable (dependency not installed or model failed to load)',
		);
		this.name = 'EmbeddingUnavailableError';
	}
}

export class EmbeddingVersionMismatchError extends Error {
	readonly queryVersion: string;
	readonly storedVersion: string;
	constructor(queryVersion: string, storedVersion: string) {
		super(
			`Embedding version mismatch: query uses ${queryVersion} but stored vectors are ${storedVersion}. Rebuild the index or pin the model version.`,
		);
		this.name = 'EmbeddingVersionMismatchError';
		this.queryVersion = queryVersion;
		this.storedVersion = storedVersion;
	}
}
