## Stage B attribution exact + semantic review routing

### What changed

- **Exact Stage B attribution**: The all-eligible-task fallback in
  `delegation-gate.ts` is removed. `parsePerTaskVerdicts` now returns a typed
  `StageBAttributionResult` with `VerdictEntry` (verdict + kind), duplicate
  detection (identical verdicts are idempotent; conflicting verdicts emit
  `STAGE_B_VERDICT_CONFLICT`), and `STAGE_B_ATTRIBUTION_MISSING` when agents
  return no structured verdict lines.
- **StageBDispatchContext**: Per-callID dispatch context captures `taskIds` and
  `expectedVerdictKind` at dispatch time, wired to the verdict consumption
  check.
- **Semantic review routing**: AST-based classification via `computeASTDiff`
  with git old-content detects high-risk categories (`GUARD_REMOVED`,
  `SIGNATURE_CHANGE`, `API_CHANGE`, `DELETED_FUNCTION`) and triggers double
  review regardless of heuristic metrics. Bounded by file count, byte size,
  and timeout.
- **Tier-3 classifier consolidation**: Shared `tier3-classifier.ts` with four
  matching strategies replaces two duplicate copies in `update-task-status.ts`
  and `task-completion.ts`.
- **Telemetry fix**: `agentName` derived from per-callID stored args instead of
  shared `activeAgent` map, fixing misattribution in concurrent dispatch.

### Why

Stage B attribution was inexact: when agents omitted structured verdict lines,
the fallback attributed results to all eligible tasks. This caused spurious
state transitions and noisy warnings. The semantic routing adds risk-aware
review depth scaling that the heuristic-only path could not provide.

### Migration

No migration required. The new behavior is backward-compatible — agents that
already emit structured `[REVIEWED]`/`[TESTED]` verdict lines are unaffected.

### Known caveats

- Semantic routing falls back to heuristic-only when AST analysis is
  unavailable, times out, or exceeds bounds (50 files / 500 KB / 5 s).
- The `git show HEAD:<file>` call for old-content requires a git repository;
  non-git directories fall back to empty old-content (all changes classified
  as additions).
