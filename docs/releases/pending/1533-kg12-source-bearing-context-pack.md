## What

- `repo_map action="context_pack"` accepts `max_tokens` (int, default 4000) — the token budget is no longer hardcoded at the tool layer.
- `context_pack` accepts `source_mode` (`"signature"` | `"body"` | `"mixed"`, default `"mixed"`) to control what source text is extracted when `include_source: true`.
- Source-bearing packs now return a `snippets` array — one snippet per returned span with extracted text, each carrying `text`, `mode` (`full` | `signature` | `summary`), sha256 `hash` of the returned text, `confidence`, and the line range.
- Every `context_pack` response now includes `coverage` (`reachedSymbols`, `returnedSymbols`, `omittedByBudget`, `unresolvedEdges`, `lowConfidenceEdges`) and `warnings` (bounded, deduplicated).
- Source reads are canonically containment-guarded: a symlink/junction inside the workspace pointing outside fails closed with span note `source outside workspace` + warning (previously a silent lexical check); missing in-workspace files still fail open with `source read failed`.
- `source_mode` without `include_source` produces an explicit warning instead of being silently ignored; stale-graph freshness notes are now also merged into `warnings`.

## Why

`context_pack` returned line spans only, so agents still needed follow-up file reads to inspect code, and had no visibility into what a budget omitted or which edges failed to resolve. KG-12 (closes #1533) makes the pack directly useful for context reduction: bounded snippets with provenance, coverage accounting, and warnings.

## Migration

No breaking changes. All new response fields are additive; span-only callers (no `include_source`) get identical spans plus the new `coverage`/`warnings` fields:

- `include_source: true` with no `source_mode` keeps embedding body text in near spans exactly as before; periphery spans additionally gain signature text (a new, previously-absent field on those spans).
- With `include_source`, per-span token cost and `estimatedTokens` now measure the extracted source text (`ceil(len/3.5)` chars-based) instead of the line-based estimate; span-only packs keep the line-based estimate.

## Caveats

- Snippet `confidence` is a deterministic resolution-quality score (1.0 exact target, 0.8 resolved neighbor), not language grammar quality. Real edge confidence/provenance arrives with KG-11 (SymbolEdge v2, #1532); `unresolvedEdges`/`lowConfidenceEdges` count distinct destination symbols, not edge instances.
- Snippet `hash` fingerprints the returned text, so `summary`-mode hashes (80-line cap) change when the cap truncates differently.
- Packing is deterministic (target → depth → file → symbol, greedy) and the target span is always included even if it alone exceeds `max_tokens` — a warning states this when it happens.
- Signature extraction is a documented heuristic (decorator-skip + `{`/`:` terminator within a bounded window; single line for no-terminator languages like Ruby), not a parser.
