# Parallel-first scheduling and phase progression use current plan bindings

## Why

Two blockers made the advertised v8 parallel-first route unreachable (issue #2532):

- The gate's disjointness verdict resolved task scopes from the legacy v1 `.swarm/scopes/scope-<taskId>.json` projection — a file no production code writes in the project root (its only writer targets lane worktrees). After `declare_scope` (the current v2 binding authority) declared disjoint scopes, the verdict still reported `unknown_scopes` and the gate permanently emitted its serial-fallback advisory.
- `plan.current_phase` had no advancing writer anywhere, and every `save_plan` revision re-pinned it to `phases[0].id`. From phase 2 onward the gate's active-phase selection was empty, the phase preflight never fired again, and the plan.md header stayed on phase 1 for the plan's lifetime.

## What changed

- The parallel verdict (and `isProvablyDisjoint`, `plan_conflict_check`, and the Rule-2 auto-commit scope lookup) now resolves scopes from the authoritative v2 binding store via a new fail-closed helper (`readDeclaredScopeFilesFromBindings`), matched against the exact plan identity (`planId` + structure hash) with one bounded binding-set scan per verdict. Zero or multiple live candidates, an unreadable store, or a missing plan resolve to `unknown` — serial. The v1 projection is no longer consulted on the standard path.
- The phase cursor gets one durable advancing writer (`normalizeCurrentPhaseInPlace` in `savePlan` and `closePlanTerminalState`, before any hash/event/snapshot): a cursor pointing at an unfinished phase is preserved across revisions; otherwise it advances to the first unfinished phase; a finished plan keeps its last phase. Ledger replay applies the same normalization, so replay, projections, and checkpoint round-trips agree.
- `current_phase` consumers converge on one canonical resolver (`resolveActivePhaseId`/`getCurrentPhase`): plan.md header (now a phase-id lookup, not an array index), summary extractor, preflight, phase monitor (whose preflight trigger now actually fires on transitions), delegation-gate active-phase selection, and handoff summaries.
- The serial-fallback advisory carries the exact reason: which tasks lack a live declaration, or which task pair conflicts on which path (bounded), instead of an ambiguous either/or.
- Documented hash semantics: a phase-boundary advancement changes the approval-baseline hash exactly like a plan revision; task-status churn inside a phase remains hash-excluded. LOCKED serial profiles are untouched — they stay serial and still reject profile mutation.

## Notes

- Plans with disjoint declared scopes now genuinely take the parallel route in any enabled phase (not just phase 1); explicit LOCKED serial intent remains serial.
- After a phase advances, scope bindings declared against the pre-advance plan stop matching until re-declared — the same lifecycle as any plan revision (declare-at-dispatch keeps this to the boundary; binding TTL is 1h).
