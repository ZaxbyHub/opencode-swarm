# Fix: phase_complete docs-participation receipts mistagged with the plan's stale current_phase cursor

## What

Resolves #2702. `phase_complete(phase=N)`'s `required_agents` docs gate could
become permanently unsatisfiable: the durable docs-participation receipt is
stamped at dispatch time with `getCurrentPhase(plan)` — the plan's
`current_phase` field, which is authored once at plan creation and never
advanced by any code path — while the gate matches receipts against the `phase`
argument. Once real work moves past the authored cursor value, every genuine
docs dispatch was tagged with the stale number and `REQUIRED_AGENTS_MISSING:
docs` blocked every subsequent `phase_complete`, no matter how many times docs
was re-dispatched.

The gate read now also accepts a receipt tagged with the plan's cursor value
(behind the completing phase) as proof for the phase being completed, and the
`phase_complete` success path re-stamps such cursor-tagged receipts to the
completed phase — healing already-poisoned stores on the first successful
completion while keeping per-phase docs participation enforced for later
phases. Recorder stamping is unchanged.

## Why

- #2109's fix made docs participation durable, but bound each receipt to a
  phase number drawn from a static authoring field, so the "receipt exists but
  phase-mistagged" variant of the same gate stayed broken (this issue).
- Advancing the cursor instead was rejected: the gate blocks before any success
  path could advance it (a deadlock for already-poisoned plans), and the field
  is consumed by unrelated callers (directive injection, phase monitor,
  directive-override scoping).

## Invariant audit

- 1 (plugin init): not touched — no init-path code changed
  (`src/evidence/phase-participation.ts` gate read + a new success-path
  function; `src/tools/phase-complete.ts` post-transition call only).
- 2 (runtime portability): not touched — no `bun:`-scheme resolution, no
  `Bun.*` calls, plugin shape unchanged; `tsc --noEmit` clean.
- 3 (subprocesses): not touched — no subprocess code added or modified.
- 4 (.swarm containment): not touched — all writes stay inside the existing
  bounded `.swarm/evidence/phase-participation.json` projection under the
  established evidence lock.
- 5 (plan durability): not touched — plan.json/plan.md/ledger untouched; no
  plan-schema change.
- 6 (test_runner safety): not touched — no tool registration or scope changes.
- 7 (test writing): touched — five new bun:test files, zero `mock.module`
  (real `.swarm/plan.json` fixtures on `createSafeTestDir` temp dirs), each
  well under the 500-line cap; existing participation/phase-complete suites
  green (run per-file, the CI-equivalent isolation loop).
- 8 (session state): not touched — no session-keyed state added; the rebind is
  directory-scoped store bookkeeping, idempotent and bounded (≤128 receipts).
- 9 (guardrails/retry): not touched — failure classification and retry paths
  unchanged; the rebind failure degrades to a `phase_complete` warning.
- 10 (chat/system msg): not touched — no message-shape changes.
- 11 (tool registration): not touched — no new tool; the receipt seam gained
  one entry used by the existing `phase_complete` tool.

## Tests

- Five frozen acceptance checks drive the fix contract: the mistagged receipt
  satisfies the completing-phase lookup (RED→GREEN), the normalization export
  re-stamps and preserves per-phase enforcement (ERROR→GREEN), recorder
  stamping and exact-match behavior are preserved (GREEN→GREEN), the
  foreign-phase rejection stays narrow (GREEN→GREEN), and the tool-level
  `phase_complete(phase=3)` unblocks and normalizes, with a rebind failure
  degrading to a warning (RED→GREEN).
- Full impacted suites re-run per file: 60+ `phase-complete*` unit files,
  `phase-participation*` evidence files, the completion-observer docs file, and
  the criticals integration file — all green; `tsc --noEmit` and biome clean;
  `scan-deferred` clean.
