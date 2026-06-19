# Knowledge-validator: context-overlap for lesson contradiction detection

## What changed

- `src/hooks/knowledge-validator.ts` now requires context overlap before flagging a Layer-3 contradiction between two lessons.
- The new `extractContextWords()` helper extracts the words within a 3-token window around each negation word in a negation pair (e.g., `always`/`never`, `must`/`must not`).
- The new `hasSignificantOverlap()` helper returns true when those two context sets share at least one token.
- A contradiction is only flagged when the negation pair is present in both lessons AND the surrounding contexts share at least one token.
- Multi-word negation terms (e.g., `must not`, `should not`, `not recommended`) are now handled correctly via a contiguous-slice scan in addition to the single-word fast path.

## Why

The previous implementation only checked whether negation-pair words were *present* in both lessons, without considering what those negations actually applied to. As a result, semantically *agreeing* lessons such as "Always run tests before commit" and "Never commit without running tests" were incorrectly flagged as contradictions because both contained the negation pair `(always, never)` and a shared tag (e.g., `testing`). This produced spurious contradiction warnings in the knowledge validation path.

The new context-overlap heuristic only flags a contradiction when the negation words attach to overlapping content, eliminating the false-positive path while still flagging true contradictions such as "Always use typescript" vs "Never use typescript" where both negations apply to the same token.

Fixes issue #1295.

## Migration steps

None. The change is a heuristic refinement in the Layer-3 contradiction warning path. Existing knowledge entries continue to load normally. No schema, storage format, or API changes.

## Known caveats

- The 3-token context window is a deliberate heuristic trade-off. Negation words whose relevant subject is more than 3 tokens away will not be detected as contradictory even if semantically opposed. This is a known limitation, not a bug.
- Exact-word match is used for context overlap. Synonyms (e.g., `use`/`utilize`) will not match across lessons, which can miss some true contradictions. The 3-token window still catches most cases via shared technical terms.
- The `['use', "don't use"]` negation pair in `NEGATION_PAIRS` is currently unreachable because `normalizeText` strips apostrophes (`don't` → `don t`). This is a pre-existing limitation unchanged by this PR.
- Layer-3 contradiction detection is advisory (`severity: 'warning'`, `valid: true`). A flagged lesson is still stored; no hard block occurs.
