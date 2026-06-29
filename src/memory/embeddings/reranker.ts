import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { warn } from '../../utils';

export interface RerankCandidate {
	id: string;
	text: string;
	score?: number;
}

/**
 * Latency gate: skip reranking when the previous recall step already
 * exceeded the caller's latency budget.
 */
export function shouldRerank(
	previousRecallElapsedMs: number,
	latencyBudgetMs: number,
): boolean {
	return previousRecallElapsedMs <= latencyBudgetMs;
}

/**
 * Cross-encoder reranker backed by @xenova/transformers (ONNX Runtime WASM).
 *
 * The transformers dependency is loaded lazily on first rerank() via
 * createRequire(import.meta.url) — never at module scope — so importing
 * this module does not pull in @xenova/transformers at load time.
 *
 * Graceful degradation: if the package is missing or the model fails to
 * load, `available` is false and rerank() returns candidates unchanged.
 */
export class CrossEncoderReranker {
	private loadFailed = false;
	private _available = false;
	private pipeline:
		| ((inputs: unknown, options?: unknown) => Promise<unknown>)
		| null = null;

	constructor(private readonly options: { model?: string }) {
		// _available starts false; flips to true only after a successful pipeline load.
	}

	get available(): boolean {
		return this._available;
	}

	/**
	 * Lazily load @xenova/transformers and initialise the text-classification
	 * (cross-encoder) pipeline. Returns the pipeline, or null on failure.
	 */
	private async ensurePipeline(): Promise<
		((inputs: unknown, options?: unknown) => Promise<unknown>) | null
	> {
		if (this.loadFailed) return null;
		if (this.pipeline) return this.pipeline;

		try {
			const req = createRequire(import.meta.url);
			const transformers = req('@xenova/transformers');

			const modelName = this.options.model ?? 'Xenova/ms-marco-MiniLM-L-6-v2';

			const cacheDir = resolveRerankerCacheDir();
			mkdirSync(cacheDir, { recursive: true });

			this.pipeline = await transformers.pipeline(
				'text-classification',
				modelName,
				{ cache_dir: cacheDir },
			);

			this._available = true;
			return this.pipeline;
		} catch (err) {
			this.loadFailed = true;
			this._available = false;
			warn('Cross-encoder reranker unavailable — skipping rerank', {
				reason: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	/**
	 * Reorder candidates by cross-encoder relevance to the query.
	 *
	 * Returns the top `topN` candidates sorted descending by cross-encoder
	 * score. If the model is unavailable, returns candidates unchanged.
	 */
	async rerank(
		candidates: RerankCandidate[],
		query: string,
		topN?: number,
	): Promise<RerankCandidate[]> {
		if (candidates.length === 0) return candidates;

		const pipeline = await this.ensurePipeline();
		if (!pipeline) return candidates;

		try {
			// Build [query, text] pairs for the cross-encoder.
			const inputs: [string, string][] = candidates.map((c) => [query, c.text]);

			const results: { label?: string; score?: number }[] = (await pipeline(
				inputs,
				{ truncation: true },
			)) as { label?: string; score?: number }[];

			// Pair each candidate with its cross-encoder score.
			const scored: RerankCandidate[] = candidates.map((c, idx) => ({
				...c,
				score: results[idx]?.score ?? 0,
			}));

			// Sort descending by score.
			scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

			if (typeof topN === 'number' && topN > 0) {
				return scored.slice(0, topN);
			}
			return scored;
		} catch (err) {
			// Pipeline ran but scoring failed — degrade gracefully.
			warn('Rerank scoring failed — returning original order', {
				reason: err instanceof Error ? err.message : String(err),
			});
			return candidates;
		}
	}
}

// ---------------------------------------------------------------------------
// Cache directory (mirrors the embedding cache layout in local-provider.ts)
// ---------------------------------------------------------------------------

function resolveRerankerCacheDir(): string {
	let base: string;
	if (process.platform === 'win32') {
		base =
			process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
	} else if (process.platform === 'darwin') {
		base = path.join(os.homedir(), 'Library', 'Caches');
	} else {
		base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
	}
	const resolved = path.join(base, 'opencode', 'embeddings');

	const segments = resolved.split(path.sep);
	if (segments.includes('.swarm')) {
		const safeDefault =
			process.platform === 'win32'
				? path.join(os.homedir(), 'AppData', 'Local', 'opencode', 'embeddings')
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
			'Reranker cache dir resolved under .swarm/ — falling back to safe default',
		);
		return safeDefault;
	}
	return resolved;
}
