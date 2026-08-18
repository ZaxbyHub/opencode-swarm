# Acceptance coverage diagnostic: omitted requirement text now reported as "completely missing"

## What changed

When the delegation gate blocks a coder/reviewer dispatch with `ACCEPTANCE_FIELD_COVERAGE_MISMATCH` because the `FR-###`/`SC-###` requirement text was **omitted** (the agent summarized instead of copying), the diagnostic no longer points at a random "divergence" word in the prompt. Previously the longest-matching-prefix algorithm could match 1–2 characters of coincidental punctuation (e.g. the `": "` after `coder task:`) and misdirect debugging to an unrelated part of the dispatch.

`describeCoverageMiss` in `src/hooks/delegation-gate.ts` now requires a minimum matching prefix (10 normalized characters, `COVERAGE_DIAG_MIN_PREFIX`) before treating a prefix match as meaningful. Below that threshold the error renders:

```
ACCEPTANCE has here: "[Requirement text completely missing from prompt]"
```

instead of a `first divergence at normalized offset …` pointer. Real divergences (a ≥10-character aligned prefix that then diverges) keep the existing divergence-pointer rendering, and encoding-corruption hints are unchanged.

## Why

Agents that summarize rather than copy requirement bodies got a misleading divergence pointer, wasting iterations on the wrong part of the prompt (issue #2204).

## Migration

No migration required — error-message-only change. Any automation string-matching the exact `first divergence at normalized offset` line for fully-omitted bodies should match the new fallback line instead.
