# feat(apply-patch): opt-in fuzzy text-matching fallback (#1718)

## What changed
- New `src/utils/sequence-matcher.ts` — a faithful TypeScript port of CPython's
  `difflib.SequenceMatcher` (Ratcliff/Obershelp + the autojunk/popular-element
  guard), so the fuzzy thresholds produce ratios matching Python's `2M/T`
  formula for ASCII/BMP content. (Astral-plane characters consume two UTF-16
  code units in JS vs one code point in Python, so ratios for emoji-heavy input
  may differ marginally — see caveat below.)
- New `src/utils/fuzzy-match.ts` — a port of hermes-agent's 9-strategy
  fuzzy-matching chain (exact, line-trimmed, whitespace-normalized,
  indentation-flexible, escape-normalized, trimmed-boundary, unicode-normalized,
  block-anchor, context-aware) plus the ambiguity guard, escape-drift guard,
  selective `\t`/`\r` unescape, Unicode preservation, and indent re-alignment.
- `apply-patch` now retries the fuzzy chain as a **fallback** when exact
  positional match fails — but only when the new opt-in config flags are set.
  The default (exact-match, the "B3 decision") is unchanged.
- New config keys under `apply_patch`:
  - `fuzzy_match` (default `false`) — enables strategies 1–8 (whitespace,
    indent, escape, unicode, block-anchor tolerance).
  - `fuzzy_match_context_aware` (default `false`) — additionally enables
    strategy 9 (loosest; requires 50% of lines to reach 0.80 per-line
    similarity). Only effective with `fuzzy_match: true`. Bounded by an
    internal cell-count cap to prevent quadratic-cost hangs on large files.
- On a fuzzy-attempted miss, the `context-mismatch` diagnostic now appends a
  "Did you mean one of these sections?" hint (ported from hermes) so the model
  can self-correct.

## Why
LLM-proposed patches frequently drift from the file text in trailing
whitespace, indentation, escape sequences (`\t` vs real tab), and Unicode
lookalikes (smart quotes, em-dashes). The exact-match-only default rejected
these, forcing costly retries. The fuzzy fallback salvages such edits while
keeping the safe exact-match default intact and gating the loosest strategy
behind a separate flag.

## Migration
None required — default behavior is unchanged. To opt in, add to
`.opencode/opencode-swarm.json`:

```json
{
  "apply_patch": {
    "fuzzy_match": true
  }
}
```

To additionally enable the loose `context_aware` strategy:

```json
{
  "apply_patch": {
    "fuzzy_match": true,
    "fuzzy_match_context_aware": true
  }
}
```

## Known caveats
- Fuzzy is a per-hunk tolerance layer, not a whole-diff position searcher.
  Multi-hunk patches where a fuzzy relocation overlaps a later hunk's declared
  context will still report a clean `context-mismatch` on that later hunk (no
  file corruption).
- The selective `\r` unescape path is inert under `apply-patch` (content is
  LF-normalized before matching); it remains active at the utility level for
  other consumers.
- The matcher operates on UTF-16 code units; astral-plane (emoji) content is
  round-trip-safe but ratios may differ marginally from CPython code-point
  semantics.
- Unicode preservation is fully effective for strategy 7 (`unicode_normalized`).
  For strategies 8/9 (`block_anchor`/`context_aware`), preservation is
  best-effort: when the matched block's normalized form does not align with the
  file region (e.g. a fuzzy middle), unchanged spans may have their Unicode
  characters (smart quotes, em-dashes) written as ASCII equivalents. This is a
  narrow residual on a doubly-opt-in path.

Closes #1718
