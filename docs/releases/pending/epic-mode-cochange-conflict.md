# Epic Mode (preview): co-change-aware conflict detection

## What changed

- New additive module `src/epic/` adds the first capability of an
  upcoming optional execution mode (`epic`) that augments Lean Turbo's lane
  planning with a git co-change signal.
- `src/epic/cochange-conflict.ts` exposes `epicPairConflict(...)` — a
  pure function that combines Lean Turbo's existing path-based pair-conflict
  primitive with a co-change-history signal, conservatively (the co-change
  signal can only escalate a verdict, never downgrade one).
- `src/epic/cochange-source.ts` composes the existing
  `co_change_analyzer` primitives (`parseGitLog`, `buildCoChangeMatrix`) and
  caches the result per project, keyed on `git HEAD`, with FIFO eviction at
  10 directories.
- `src/config/schema.ts` adds an additive `EpicConfigSchema`, configured
  as the top-level `epic` block (the older `turbo.epic` path is still
  accepted and migrated — see `epic-mode-v2.md`). The new keys are
  `epic.cochange.enabled` (default `false`),
  `epic.cochange.threshold` (NPMI floor, default `0.6`), and
  `epic.cochange.min_co_changes` (default `5`).
- New tests at `tests/unit/epic/` cover the signal combinations,
  threshold gating, greenfield / signal-absent behavior, and a dedicated
  "feature disabled ⇒ identical to before" passthrough fixture.

## Why

Lean Turbo's lane planner detects task conflicts using path-based rules only
(same file, parent/child directory, global file, protected path, cross-lane
dependency). The project already computes co-change coupling via
`co_change_analyzer` during DISCOVER and surfaces it to the architect, but
the signal is not consumed by the lane planner. As a result, file pairs that
historically change together but share no static import edge ("dark matter"
coupling) can be parallelized by Lean Turbo even when they should not be.

This change does not modify Lean Turbo. It introduces a new, isolated module
that the future `epic` mode will use as its conflict-detection layer.
Capability A ships in this PR; the `epic` mode that consumes it ships
separately in a later PR once the project's mode-registration pattern has
been re-verified end-to-end.

## Migration steps

None. With `epic.cochange.enabled` left at its default (`false`), no
Epic-mode code runs in any existing flow and Lean Turbo, Turbo, Full-Auto,
and all other modes behave exactly as before. The
`tests/unit/epic/disabled-passthrough.test.ts` fixture confirms this
explicitly.

## Breaking changes

- None. The schema additions are optional fields with conservative defaults.
  Every existing config payload continues to validate unchanged.

## Known caveats

- Capability A is an isolated module in this PR. It is not wired into any
  runtime flow yet; that wiring lands with the `epic` mode in a later
  capability (auto-activation).
- The NPMI threshold (`0.6`) and `min_co_changes` (`5`) defaults are
  deliberately stricter than the `co_change_analyzer`'s discovery defaults
  (`0.5` and `3` respectively). They are reasoned starting points, not
  measured optima.
- The data-source cache is in-memory only. A process restart clears it; the
  next call re-runs the analyzer for that project.
