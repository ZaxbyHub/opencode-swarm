# Epic Mode (preview): `/swarm coupling` KPI + decoupling roadmap

## What changed

- New `/swarm coupling` slash command (category: `diagnostics`) that computes
  the coupling coefficient `p` for the current plan and produces a ranked
  decoupling roadmap. Read-only: changes no execution behavior.
- New module `src/epic/coupling-report.ts` exposing:
  - `computeCouplingReport(tasks, cochangePairs, threshold, options?)` — a
    pure function that returns `{ p, taskCount, totalPairs,
    conflictingPairCount, conflictingPairs, perModule, roadmap }`.
  - `formatCouplingReportMarkdown(report)` — renders the report as markdown.
- New handler `src/commands/coupling.ts` that loads the plan, resolves task
  scopes (declared-scope file first, `files_touched` fallback — mirrors Lean
  Turbo's planner), queries `getCoChangePairs` for the co-change signal,
  computes the report, and emits markdown or JSON per the `--format` flag.
- Additive entry in `src/commands/registry.ts` registering the new command
  alongside `/swarm dark-matter`.
- 35 new tests covering edge cases, `p` value correctness, per-module
  attribution, roadmap ranking and truncation, argument parsing, phase
  scoping, format switching, and `--persist` file output.

## Why

Lean Turbo's lane planner today decides parallelization based on path-based
conflicts only. The first Epic Mode capability (co-change-aware pair
conflict) adds an empirical coupling signal — but the team has no way to
*see* what that signal would say for their current plan before opting into
the runtime integration.

`/swarm coupling` closes that gap. It is read-only, runs independent of
`epic.cochange.enabled`, and answers the natural questions: "how
parallelizable is my plan?", "which modules cause the most coupling?", and
"what's the highest-leverage decoupling refactor?". The answers are
explicitly framed as estimates (per design rule §4.2), not measured
production outcomes.

## Migration steps

None. The command is new; no existing command, hook, or behavior is
affected. Plans without scopes or without git history produce a
gracefully-degraded report (p computed from whatever signal is present, or
"no tasks to analyze" when the plan is empty).

## Breaking changes

- None.

## Known caveats

- `--persist` writes under `.swarm/epic/coupling-report.json`. The directory
  is created on first use. The write is atomic via `tmp + rename` (matches
  the lean-turbo state pattern).
- The decoupling-roadmap heuristic ranks modules by their frequency in
  conflicting pairs. A future capability could simulate "predicted `p`
  reduction if module X is isolated"; this initial release keeps the
  report shape simple.
- Hot-module / blast-radius detection (auth, DB schema, shared middleware,
  etc.) is intentionally not in this command — that's a separate Capability
  C concern. M2 stays focused on per-pair-contention ranking.
