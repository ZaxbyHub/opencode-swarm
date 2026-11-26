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
stored `specHash`, or an already-consistent hash it still returns `no_marker`
only when no pending or invalid WAL exists. A PREPARED/corrupt WAL fails closed,
protected plan mutations stay blocked until canonical recovery completes, and
`/swarm reset --confirm` clears the WAL with the plan epoch. Canonical repair
also refuses to report success when the just-published spec is unreadable or
over the native reader's 256 KiB UTF-8 byte limit. `acknowledge-spec-drift`
behavior is untouched (flag unset → marker-only semantics).

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

## Review fixes (F-001..F-004, PR 3920 review round + closeout revision)

- F-001: a crash-retry of the markerless reconciliation with a later clock
  re-synthesized a different marker identity (the old hash folded
  `timestamp: now()` in), so the PREPARED WAL replay misread it as an
  on-disk marker replacement and fabricated a blocking
  `.swarm/spec-staleness.json` that never existed — re-wedging the flow the
  transaction had just repaired. The synthesized identity is now hashed from
  the stable drift fields only, and a synthesized (no-on-disk-marker)
  identity can never trigger the preserved-marker path. A same-content
  later-clock retry replays the same transition and finishes `applied`
  without creating a marker; genuine on-disk replacement markers and actual
  newer drift keep their protection.
  Closeout revision: the recovery WAL is now read BEFORE the markerless
  matching-hash shortcut, and a pending PREPARED WAL bypasses that shortcut.
  A crash after the plan rebind persisted but before the ledger snapshot /
  audit event / WAL COMMITTED legs ran used to leave the incomplete
  transaction stranded (retry reported "No spec drift detected."); the retry
  now replays the PREPARED recovery idempotently to `applied` with the
  snapshot and audit legs materialized exactly once, while a consistent plan
  with no pending WAL stays a genuine no-op.
  Stage B round 2 revision: the recovery WAL is also VALIDATED before the
  matching-hash shortcut — `parseWal` maps a corrupt WAL to null, so a
  present corrupt WAL used to slip past the `existingWal?.state !==
  'PREPARED'` gate and return `no_marker` instead of failing closed. A
  consistent plan with a corrupt WAL now fails with the corrupt-WAL repair
  message, while no-WAL and COMMITTED-WAL consistent plans remain genuine
  no-ops.
  Stage B round 3 revision: captured-content integrity is validated before
  any markerless shortcut, for PREPARED and COMMITTED WALs alike — a
  structurally parseable WAL whose captured `specContent` no longer hashes
  to its `newHash` used to slip past the corrupt-WAL check and, when
  COMMITTED, return `no_marker` before the transaction integrity check ever
  ran. Such a WAL now fails with the inconsistent-captured-content message;
  the valid COMMITTED no-op control is unchanged.
  Stage B round 4 revision: the missing-plan / missing-specHash shortcut no
  longer reports no work when a PREPARED WAL is pending — a plan lost or
  downgraded (no stored specHash) after the transaction was prepared used to
  return `no_marker`, bypassing the unfinished recovery and the replay's
  fail-closed plan checks. It now fails closed with the pending transition
  context, while no-WAL missing-plan and hashless-plan runs keep their
  genuine `no_marker` behavior. Falsified by the split regression suites:
  `tests/unit/services/spec-drift-recovery-premarker-replay.test.ts` covers
  stable retry identity and recurring-transition audit identity, while
  `tests/unit/services/spec-drift-recovery-premarker-failclosed.test.ts`
  covers corrupt/incomplete WAL failures. The recorded source mutants fail
  those assertions (`cleanup_pending` / `no_marker` or reused audit identity)
  and the restored suites pass.
- F-002: the `[spec-drift]` advisory told the model to pause until "the user
  runs /swarm acknowledge-spec-drift", conflicting with the
  SPEC_DRIFT_BLOCK and `/swarm status` guidance that name canonical
  `spec_write` as an agent-executable repair. The advisory now pauses the
  listed operations until the drift is cleared by a successful canonical
  `spec_write` or by user acknowledgment.
  Closeout revision: the "cleared" verdict is conditioned on the recovery
  actually succeeding — `spec_write` can return `written: true` while its
  embedded drift recovery failed or is still pending, so the advisory now
  says to treat the drift as cleared only when the result reports
  `spec_drift_recovery` applied (or `no_marker` with the plan already
  consistent), and to keep the block in force otherwise. Pinned by a new
  test in `tests/unit/hooks/spec-drift-advisory.test.ts`.
- F-003: added the negative control — `acknowledge-spec-drift` with a stale
  plan hash and no marker keeps marker-only semantics (`no_marker`, nothing
  rebound or created).
- F-004: the pre-marker rebind test now also asserts the durable LEDGER
  snapshot bound to the recovery transition (`ensureSnapshotEvent` →
  `plan-ledger.jsonl`), not just the events.jsonl audit line and the
  spec snapshot file. Falsified by disabling the snapshot append (test
  fails, then passes restored).
- Closeout F-001: when the plan lock is busy, the canonical `spec_write`
  reports `retry_later` before any WAL or plan change. The new spec used to
  stay published while still bound to the old plan hash, so the next
  `loadPlan` could materialize the drift marker and wedge `save_plan`. It now
  restores the prior `spec.md` bytes and returns `written: false` with the
  retry guidance. A failed restore is reported as `written: true` with a
  `failed` recovery status. Pinned by the lock-busy test in
  `tests/unit/tools/spec-write-spec-drift-recovery.test.ts`; removing the
  restore fails it.
- Closeout F-002: the synchronous mutation gate now applies the same
  captured-content check as the recovery run. A structurally valid COMMITTED
  WAL whose `specContent` no longer hashes to `newHash` blocks protected
  mutations as corrupt, instead of passing as COMMITTED. Pinned by
  `tests/unit/services/spec-drift-wal-gate-integrity.test.ts`; removing the
  check fails the tampered-WAL case.
