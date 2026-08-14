## What

- New `repo_map action="ask"` for zero-LLM file localization: vocabulary expansion, IDF-weighted lexical seeding, and personalized PageRank over the file-level dependency graph.
- `context_pack` gains `include_source` option to embed source text in spans (default false, fail-open on read errors).
- `context_pack` no longer silently drops BFS-reached symbols without `exportRanges`; they now emit a file-level signature pointer with a note.
- `key_files` and `package_boundaries` responses include `community` (inferred package boundary) and normalized `hubScore` (0-1).
- All list-returning actions (`key_files`, `package_boundaries`, `dead_exports`, `context_pack`, `ask`) include `budget: { returned, dropped? }` for truncation visibility.

## Why

Agents need structural file localization without LLM calls, source text without opening every file individually, and visibility into how many results were truncated. Closes #1987.

## Migration

No breaking changes. All new fields are additive:
- `ask` is a new action (existing actions unchanged).
- `include_source` defaults to `false`; existing `context_pack` calls return identical shapes.
- `budget`, `community`, `hubScore` are new fields on existing responses.
- Internal-symbol fallback adds spans that were previously silently dropped.

## Caveats

- `ask` is orientation only — it ranks files by structural relevance but does not read or analyze file contents. Always read the located files before asserting anything about them.
- `include_source` text is bounded to 80 lines per span, only applies to full-mode spans (not signature spans), and respects the token budget. Unreadable files fail open (span without text, with a note).
- `hubScore` on `package_boundaries` uses `dependedOnBy.length` (boundary-level in-degree), not per-file in-degree.
- `budget.dropped` is omitted on `dead_exports` where the total candidate count is not available without additional computation.
- `ask` uses no stemming: "saved" will not match the export "saveGraph" via the stem "save". Query with the exact identifier for best results.
