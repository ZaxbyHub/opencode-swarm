# spec_write reconciles the plan specHash before the drift marker materializes

## What changed

A canonical `spec_write` now rebinds the plan's `specHash` to the freshly
written spec even when `.swarm/spec-staleness.json` does not exist yet. The
SPEC_DRIFT_BLOCK and `/swarm status` guidance was also rewritten to name the
agent-executable repair path (canonical `spec_write` via the spec_writer
agent) instead of only pointing at `/swarm clarify`, which is not a
`swarm_command` registry entry.

## Why

Field wedge (Wirtschaftssimulation session, 2026-11-22): the drift marker is
written lazily by the next `loadPlan`, which runs *after* a canonical spec
write. So the natural repair sequence always deadlocked:

1. plan saved with the old spec hash → canonical `spec_write` replaces the
   spec → `reconcileSpecDrift` returns `no_marker` (nothing rebound),
2. the next `loadPlan` (inside `save_plan`) materializes the marker,
3. `save_plan` / `update_task_status` / `phase_complete` wedge with
   `SPEC_DRIFT_BLOCK`, and the error text told the agent to run
   `/swarm clarify` — a TUI slash command that does not exist in the
   `swarm_command` registry, so the architect had no executable repair path
   and had to stop for human intervention (`/swarm acknowledge-spec-drift`).

The documented contract ("accepted changes must be persisted through
canonical `spec_write` to reconcile the plan hash") was only implemented for
the marker-already-exists window; the first canonical spec change could never
reconcile anything.

## How it works

`reconcileSpecDrift` gained an opt-in `reconcilePlanHashWithoutMarker` flag
(set only by `spec_write`). When no marker exists, it synthesizes the drift
state from `plan.json` itself (stored vs current effective-spec hash) and runs
the same audited repair transaction as the marker path: WAL (PREPARED →
COMMITTED), plan-hash rebind through `savePlan`, ledger snapshot event,
`spec_drift_repaired` audit event, verified spec snapshot. With no plan, no
stored `specHash`, or an already-consistent hash it still returns
`no_marker` unchanged. `acknowledge-spec-drift` behavior is untouched
(flag unset → marker-only semantics).

## Verification

- New regression tests in
  `tests/unit/tools/spec-write-spec-drift-recovery.test.ts` (pre-marker
  rebind, already-consistent control, pre-feature-plan control); the rebind
  test fails on pre-fix source (`no_marker`, stale `specHash`) and passes
  after the fix.
- Neighboring suites green: spec-drift-recovery commit/prepared v2,
  spec-drift-adversarial, spec-drift-diff, acknowledge-spec-drift,
  spec-obligation-allowlist, status-service-spec-drift, spec-drift-block,
  spec-drift-advisory, plan manager staleness suites, close-cleanup/
  finalizer, guardrail-explain accuracy.
