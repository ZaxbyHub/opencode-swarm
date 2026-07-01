## What changed

Added optional hybrid (lexical + dense vector) retrieval to the swarm memory system, fused via Reciprocal Rank Fusion (RRF). The deterministic 9-factor lexical scorer (FTS5 BM25) remains the fast default stage 1; an optional `sqlite-vec` dense vector stage 2 adds semantic recall so meaning-based queries (e.g. "how do I handle a failed login") can surface memories that share no tokens with the query (e.g. "bcrypt session invalidation on authentication failure"). Fully opt-in (`memory.embeddings.enabled`, default `false`) and degrades gracefully to lexical-only when the optional `sqlite-vec` / `@xenova/transformers` binaries are absent.

Components (new `src/memory/embeddings/` module):
- **Embedding config** (`embeddings` + `retrieval` blocks in `MemoryConfig` / `MemoryConfigSchema`): opt-in `enabled=false`, `model` (default `Xenova/all-MiniLM-L6-v2`), `dimension` (384, `.int().min(1)`), `version`, `cacheSize` (256); `retrieval.rrfK` (60), `retrieval.weights` (lexical 0.5 / dense 0.4 / metadata 0.1), `retrieval.rerank.enabled` (false), `retrieval.latencyBudgetMs` (250).
- **Migration v6** (`embedding_config` marker table) + runtime `vec0` virtual table creation gated on a `vecAvailable` flag with try/catch + non-fatal warning.
- **LocalEmbeddingProvider** — lazy `@xenova/transformers` load via `createRequire` (NOT module scope, preserving the Node-ESM-loadable bundle), graceful degradation via `EmbeddingUnavailableError`, model weights cached user-scoped per FR-011 (Linux `~/.cache/opencode/embeddings/`, macOS `~/Library/Caches/opencode/embeddings/`, Windows `%LOCALAPPDATA%/opencode/embeddings/`) with `.swarm/` containment.
- **EmbeddingCache** — per-session LRU (default 256), keyed by `(modelVersion, normalizedQuery)`, cleared on store reset / reindex; wired into the dense query path so repeated same-text queries reuse the embedding.
- **Write-time embedding** (`writeMemoryVec`) — durable memories only (scratch/ephemeral and pending proposals excluded until promoted); embed failure is non-fatal (memory stored without a vector).
- **Dense retrieval** (`selectDenseCandidates`) — independent KNN over the full `memory_items_vec` table (cosine similarity), scoped identically to the lexical path; oversampled (`max(100, 20×maxItems)`) to mitigate post-filter scope recall loss.
- **Version integrity** — global `model_version` seeded only when absent (`INSERT OR IGNORE`), `EmbeddingVersionMismatchError` on cross-version query, `rebuildEmbeddingIndex()` re-embeds + advances the version + clears the cache.
- **RRF fusion** (`fuseRankings`) — 3-channel rank fusion `weight · 1/(rrfK + rank)` (lexical/dense/metadata), lexical score normalized by the 1.13 weight sum, final scores min-max normalized to `[0,1]` for consistent `minScore` thresholding.
- **recallWithDiagnostics integration** — two-stage pipeline (lexical + dense) with a **byte-identical disabled-path guarantee**: when `embeddings.enabled=false` the recall output (incl. diagnostics shape) is exactly the prior lexical-only result (FR-002/FR-006 no-regression); dense failure falls back to true lexical-only.
- **Optional cross-encoder reranking** (`CrossEncoderReranker`, lazy `ms-marco-MiniLM-L-6-v2`) — latency-gated (skips when the previous recall exceeded `latencyBudgetMs`), reranks the top-20 fused prefix with the untouched tail appended, graceful fallback to fused-only on failure.
- **Docs** (`docs/memory.md`) — full hybrid pipeline documented end-to-end.
- **Tests** — ~245 new tests (config validation/adversarial, migration/vec degradation, types, provider lazy-load + FR-011 + `.swarm` containment, cache LRU, write-time embedding guards, dense retrieval guards + scoping, fusion math, recall byte-identical disabled path, reranker, version enforcement, portability/degradation), 3 paraphrase fixtures (zero lexical overlap).

## Why

Highest-impact retrieval-quality improvement for the current memory architecture: keeps lexical precision (exact-symbol recall — function names, file paths, config keys) while adding semantic recall (meaning-based matching). The issue's SME research identified hybrid retrieval with `sqlite-vec` as the #1 recommendation. Addresses audit finding DD-15 and the recall-quality gap surfaced by Phase 3 consolidation.

## Migration steps

No migration action required from users. The new schema migration (v6) runs automatically and is safe when `sqlite-vec` is absent (the `vec0` virtual table is created at runtime only if the extension loads). Existing configs are unchanged — the feature is opt-in (`memory.embeddings.enabled` defaults to `false`), and recall behaves byte-identically to the prior lexical-only path when disabled.

To opt in (requires `@sqlite/sqlite-vec` and `@xenova/transformers` resolvable at runtime — they are intentionally NOT hard dependencies):

```json
{
  "memory": {
    "embeddings": { "enabled": true, "model": "Xenova/all-MiniLM-L6-v2", "dimension": 384 },
    "retrieval": { "rrfK": 60, "weights": { "lexical": 0.5, "dense": 0.4, "metadata": 0.1 } }
  }
}
```

## Breaking changes

None. Purely additive and opt-in; disabled path is byte-identical.

## Known caveats

- `@xenova/transformers` (~25MB model download on first use) and `@sqlite/sqlite-vec` are optional, runtime-resolved dependencies (not in `package.json`); the plugin loads and recall works without them (lexical-only). First-use model download prints a one-time notice.
- The `vecAvailable=true` real embed/KNN/rerank paths are exercised by guard/degradation tests locally; full end-to-end verification of the dense path requires the binaries present (CI matrix).
- `all-MiniLM-L6-v2` is strong for natural-language intent but not code-specific; the model is configurable for code-heavy deployments.
- Scope post-filtering on the dense KNN result uses oversampling (`max(100, 20×maxItems)`); pre-filtering via `vec0 WHERE` is a documented future improvement for very tight scope filters.
