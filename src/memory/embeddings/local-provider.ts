import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../../utils';
import type { EmbeddingProvider } from './types';
import { EmbeddingUnavailableError } from './types';

// FR-011: Embedding model weights use platform-standard cache directories,
// which DIFFER from the plugin cache paths in src/config/cache-paths.ts.
// Plugin cache follows XDG conventions (~/.cache on all non-Windows).
// Embeddings follow OS-native conventions: ~/Library/Caches on macOS
// (XDG is NOT macOS-native, so XDG_CACHE_HOME is ignored on darwin),
// %LOCALAPPDATA% on Windows, XDG on Linux. This is intentional — not duplication.
// See FR-011 and AGENTS.md invariant 4 (.swarm containment).
export const _internals = {
	/**
	 * Exposed for direct unit testing — do not call from production code.
	 * Verifies .swarm containment by checking path segments post-resolution.
	 */
	resolveEmbeddingCacheDir(): string {
		let base: string;
		if (process.platform === 'win32') {
			base =
				process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
		} else if (process.platform === 'darwin') {
			// FR-011: macOS platform-standard is ~/Library/Caches. XDG is not macOS-native — do NOT honor XDG_CACHE_HOME on darwin.
			base = path.join(os.homedir(), 'Library', 'Caches');
		} else {
			base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
		}
		const resolved = path.join(base, 'opencode', 'embeddings');

		// .swarm containment: never allow model weights under .swarm/ even via pathological env overrides.
		const segments = resolved.split(path.sep);
		if (segments.includes('.swarm')) {
			const safeDefault =
				process.platform === 'win32'
					? path.join(
							os.homedir(),
							'AppData',
							'Local',
							'opencode',
							'embeddings',
						)
					: process.platform === 'darwin'
						? path.join(
								os.homedir(),
								'Library',
								'Caches',
								'opencode',
								'embeddings',
							)
						: path.join(os.homedir(), '.cache', 'opencode', 'embeddings');
			warn(
				'Embedding cache dir resolved under .swarm/ — falling back to safe default',
			);
			return safeDefault;
		}
		return resolved;
	},
};

function resolveEmbeddingCacheDir(): string {
	return _internals.resolveEmbeddingCacheDir();
}

/**
 * Embedding provider backed by @xenova/transformers (ONNX Runtime WASM).
 *
 * The transformers dependency is loaded lazily on first embed()/embedBatch()
 * via createRequire(import.meta.url) — never at module scope — so the plugin
 * bundle remains Node-ESM-loadable even when @xenova/transformers is not installed.
 *
 * Graceful degradation (FR-003): if the package is missing or the model fails
 * to load, available is set to false and embed() rejects with EmbeddingUnavailableError.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
	private readonly modelName: string;
	/** The dimension of vectors this provider emits (e.g. 384 for all-MiniLM-L6-v2). */
	readonly dimension: number;
	/** The pinned model+dimension version identifier this provider produces. */
	readonly modelVersion: string;
	private _available: boolean = false;
	/** Cached failure flag — prevents repeated failed require() calls on every embed(). */
	private loadFailed: boolean = false;
	private pipeline:
		| ((texts: string | string[], options?: unknown) => Promise<unknown>)
		| null = null;

	/** One-time download notice guard — prints once per process. */
	private static downloadNoticePrinted: boolean = false;

	constructor(config: {
		model: string;
		dimension: number;
		version?: string;
	}) {
		this.modelName = config.model;
		this.dimension = config.dimension;
		this.modelVersion = config.version ?? `${config.model}:${config.dimension}`;
	}

	/** false until the model pipeline loads successfully; true after. */
	get available(): boolean {
		return this._available;
	}

	/**
	 * Lazily load @xenova/transformers and initialize the feature-extraction pipeline.
	 * Returns the pipeline function, or null if loading failed (graceful degradation).
	 */
	private async ensurePipeline(): Promise<
		((texts: string | string[], options?: unknown) => Promise<unknown>) | null
	> {
		if (this.loadFailed) {
			return null;
		}
		if (this.pipeline) return this.pipeline;

		try {
			const req = createRequire(import.meta.url);
			// Dynamic require — throws if @xenova/transformers is not installed.
			const transformers = req('@xenova/transformers');

			// One-time notice for first-use model download (~25MB for all-MiniLM-L6-v2).
			if (!LocalEmbeddingProvider.downloadNoticePrinted) {
				LocalEmbeddingProvider.downloadNoticePrinted = true;
				// eslint-disable-next-line no-console
				console.log(
					`[opencode-swarm] Downloading embedding model "${this.modelName}" (~25 MB) — this happens once per process.`,
				);
			}

			// Configure the cache dir for model weights (FR-011).
			const cacheDir = resolveEmbeddingCacheDir();
			// Ensure the cache directory exists.
			mkdirSync(cacheDir, { recursive: true });

			// Initialize the feature-extraction pipeline.
			this.pipeline = await transformers.pipeline(
				'feature-extraction',
				this.modelName,
				{ cache_dir: cacheDir },
			);

			this._available = true;
			return this.pipeline;
		} catch (err) {
			// Graceful degradation: dependency missing or model failed to load.
			this.loadFailed = true;
			this._available = false;
			warn(
				'Local embedding provider unavailable — falling back to lexical-only',
				{
					reason: err instanceof Error ? err.message : String(err),
				},
			);
			return null;
		}
	}

	/**
	 * Compute an embedding vector for a single text.
	 * Rejects with EmbeddingUnavailableError if the provider is not available.
	 */
	async embed(text: string): Promise<Float32Array> {
		const pipeline = await this.ensurePipeline();
		if (!pipeline) {
			throw new EmbeddingUnavailableError(
				'Embedding provider is unavailable (dependency not installed or model failed to load)',
			);
		}

		const result = await pipeline(text, {
			pooling: 'mean',
			normalize: true,
		});

		return this.tensorToFloat32Array(result);
	}

	/**
	 * Compute embeddings for a batch of texts. Order preserved.
	 * Rejects with EmbeddingUnavailableError if the provider is not available.
	 */
	async embedBatch(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];

		const pipeline = await this.ensurePipeline();
		if (!pipeline) {
			throw new EmbeddingUnavailableError(
				'Embedding provider is unavailable (dependency not installed or model failed to load)',
			);
		}

		const result = await pipeline(texts, {
			pooling: 'mean',
			normalize: true,
		});

		// Batch result may be a single tensor with batch dimension or an array of tensors.
		if (Array.isArray(result)) {
			return result.map((t) => this.tensorToFloat32Array(t));
		}

		// Single tensor with shape [batch, dim] — split into individual vectors.
		return this.tensorToFloat32ArrayBatch(result);
	}

	// ------------------------------------------------------------------
	// Internal helpers
	// ------------------------------------------------------------------

	/** Convert a @xenova/transformers output tensor to a Float32Array. */
	private tensorToFloat32Array(tensor: unknown): Float32Array {
		// The pipeline with pooling:'mean' returns { data: Float32Array, dims: number[] }
		// or a raw Float32Array depending on version.
		if (tensor instanceof Float32Array) return tensor;

		const obj = tensor as { data?: Float32Array; dims?: number[] } | null;
		if (obj?.data && obj.data instanceof Float32Array) {
			return obj.data;
		}

		// Fallback: try to extract from a generic tensor-like object.
		const entries = Object.entries(tensor as Record<string, unknown>);
		for (const [, value] of entries) {
			if (value instanceof Float32Array) return value;
		}

		throw new Error(
			`Unexpected embedding tensor shape: ${JSON.stringify(tensor)}`,
		);
	}

	/** Split a batch tensor [batchSize, dim] into an array of Float32Array. */
	private tensorToFloat32ArrayBatch(tensor: unknown): Float32Array[] {
		const obj = tensor as { data?: Float32Array; dims?: number[] } | null;

		if (
			obj?.data &&
			obj.data instanceof Float32Array &&
			obj.dims &&
			obj.dims.length >= 2
		) {
			const batchSize = obj.dims[0];
			const dim = obj.dims[1];
			const result: Float32Array[] = [];
			for (let i = 0; i < batchSize; i++) {
				const offset = i * dim;
				result.push(obj.data.slice(offset, offset + dim));
			}
			return result;
		}

		// If it's already an array of tensors, map through tensorToFloat32Array.
		if (Array.isArray(tensor)) {
			return tensor.map((t) => this.tensorToFloat32Array(t));
		}

		throw new Error(
			`Unexpected batch embedding tensor shape: ${JSON.stringify(tensor)}`,
		);
	}
}
