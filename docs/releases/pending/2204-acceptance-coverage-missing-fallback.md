# Acceptance coverage diagnostic: distinguish an omitted requirement body from one present but misaligned

## What changed

When the delegation gate blocks a coder/reviewer dispatch with `ACCEPTANCE_FIELD_COVERAGE_MISMATCH`, the diagnostic now distinguishes two failures that previously rendered the same way:

- The requirement body was **omitted** (the agent summarized instead of copying). Previously the diagnostic ran a single longest-matching-prefix scan, which could latch onto 1–2 characters of coincidental punctuation (e.g. the `": "` after `coder task:`) and point debugging at a random "divergence" word elsewhere in the dispatch. It now reports the text as missing outright.
- The requirement body is **present in the prompt but not aligned at character 0** — for example when pasted behind an id label, or misaligned by spec.md-side encoding corruption near the start. When a ≥10-character prefix or suffix of the body still lines up somewhere in the prompt, this is no longer reported as missing; the diagnostic points at the mismatched head instead. (See "Known limitations" below for cases where fragments of the body are present but neither edge of it clears the threshold.)

`describeCoverageMiss` in `src/hooks/delegation-gate.ts` now requires a minimum of 10 normalized characters (`COVERAGE_DIAG_MIN_PREFIX`) taken from **either end** of the requirement body to turn up in the acceptance text. When neither does, the error renders:

```
ACCEPTANCE has here: "[Requirement text completely missing from prompt]"
```

instead of a `first divergence at normalized offset …` pointer.

Concretely: a body is reported completely missing only when **neither** a ≥10-character prefix from the start of the body, **nor** a ≥10-character suffix of the body, appears as a substring **anywhere** in the full acceptance/prompt text. Both probes are position-independent on the prompt side — they ask "does this piece of the body occur somewhere in the prompt", never "does the prompt start or end with it". That matters because the text compared here is the whole delegation prompt (`prompt`/`description`/`task`/`input`/`message` concatenated), so a correctly-pasted body normally sits in the middle of it, with other fields before and after — a dispatch commonly continues past `ACCEPTANCE:` with fields such as `SKILLS:`, `SKILLS_USED_BY_CODER:`, or `OUTPUT:`, for instance (not every agent role includes all of these, and `SKILLS:` can also be auto-injected after this check runs, so ACCEPTANCE is not reliably the last field, only commonly not the last).

When either probe hits, the existing divergence-pointer rendering is used and points at the region surrounding the mismatched head — the rendered snippets show the context around the point of misalignment, not necessarily the matched substring itself (see "Known limitations" below). The suffix probe is what rescues a body that is fully present but not aligned at character 0 — for example, `extractSpecRequirementBodyById` extracts everything after the closing `**` of a spec bullet's leading bold span, so a bullet such as `- **FR-001**: <body>` leaves a `": "` glue on the extracted body; if the architect pastes it behind an id label (`ACCEPTANCE: FR-001 - <body>`, followed by the usual `SKILLS:` line), the misalignment kills the prefix probe, the suffix probe finds the body mid-prompt, and the diagnostic points at the id-label glue instead of claiming the requirement text is absent. The same applies when `spec.md` is encoding-corrupted near (but not at) the start of the body. Encoding-corruption hints are unchanged and are attached in both cases when present.

## Why

Agents that summarize rather than copy requirement bodies got a misleading divergence pointer, wasting iterations on the wrong part of the prompt (issue #2204).

The suffix probe exists because the missing-text fallback is a much worse failure than the pointer it replaced: it tells the architect the requirement text is absent from a prompt that visibly contains it, so the obvious remedies (re-paste the body) all appear to change nothing. Any check anchored on the END of the compared text would produce exactly that: a dispatch commonly has more content after `ACCEPTANCE:` (fields like `SKILLS:`, `SKILLS_USED_BY_CODER:`, or `OUTPUT:`), so a body that is genuinely present would sit in the middle of the prompt rather than at its tail — which is why the suffix probe searches the whole prompt rather than checking only its literal end (issue #2215).

## Known limitations

**Coincidental edge match.** Both probes are structurally identical (a growing window anchored at one end of the requirement body, tested with a substring-anywhere `.includes()` search against the prompt) and share the same 10-character threshold. A genuinely-omitted body whose own leading **or** trailing 10+ characters happen to recur elsewhere in the prompt by coincidence is not guaranteed to render the completely-missing fallback — it instead renders the divergence-pointer, pointing at the surrounding context of the coincidental match. The rendered snippets show what precedes/surrounds the match, not the matched substring itself, so in this case the pointer does not name what actually matched. This is not a new risk introduced by the suffix probe: the original #2204 prefix probe already carried the identical risk for the body's leading characters; this change applies the same heuristic symmetrically to the body's trailing characters rather than introducing an asymmetry.

**Fragmentary presence.** Conversely, when parts of the body are genuinely present in the prompt but neither its first 10 nor its last 10 normalized characters individually clear the threshold (for example when both the start and the end of the body are paraphrased or trimmed, leaving only a verbatim middle section), the diagnostic still renders the completely-missing fallback even though partial content is present. This limitation is pre-existing to #2204's original prefix-only check and is not addressed by this change.

Both limitations share the same root cause — a fixed-length, edge-anchored character-count threshold rather than a more general presence check — and are worth revisiting together if either proves troublesome in practice.

## Migration

No migration required — error-message-only change. Automation matching the diagnostic text should note two changes: the fully-omitted case renders the `[Requirement text completely missing from prompt]` fallback instead of a `first divergence at normalized offset` line, and the explanatory line above that fallback has been reworded to describe both probes.
