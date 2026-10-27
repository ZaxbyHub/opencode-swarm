# Reset-session partial failures are loud and name the working recovery

## What

A partially-failed `/swarm reset-session` (SQLite row clear, projection
unlink, or state.json unlink failing) now tells the operator what happened
and how to recover, instead of stopping silently and pointing at a recovery
command that refuses exactly that state.

- The moment a reset leaves the closing coordination guard intentionally
  installed, exactly one always-visible operational advisory is emitted
  (`/swarm diagnose` channel, never chat-visible): durable session-snapshot
  persistence is stopped until a reset-session run succeeds — re-run
  `/swarm reset-session` (or restart the host) to recover.
- As belt-and-braces, `writeSnapshot` also emits one bounded advisory per
  project root per stop episode if a write fails while the guard is closed
  (the strand-time warning could have been missed in a long-lived process).
- `/swarm recover --coordination` now distinguishes the failure classes
  instead of printing one refusal for everything: a settled cleanup-stranded
  closing names the reset re-run recovery; an entry that is still settling
  keeps the "wait for the underlying attempt to settle" advice (which is
  correct there, and only there); ordinary initialization failures no longer
  carry that advice; shutdown-marked and in-flight-reset windows state their
  own truthful guidance.
- `/swarm status` renders origin-specific recovery lines for the same
  classes (previously one generic unsettled-timeout line for every state,
  including `closing (settled)`).
- The `/swarm reset-session` help entry documents partial failure: which
  steps can fail, that the closing guard intentionally stays installed
  (fail-closed containment), and the actual recovery path.

## Why

The closing guard left behind by a partially-failed reset is intentional
containment (#2481); the defect was the operator contract around it — the
persistence stop was silent (one debug-gated log line whose docstring said
"silently swallows errors"), the dedicated recovery command refused exactly
that state with advice that assumed an unsettled attempt, and status printed
the same generic recovery line for every non-succeeded coordination state
(frontier-audit finding `t1s1-r1-K2`, dual-review HIGH-borderline, Workstream
J slot J-14 / issue #2963).

## Migration

No breaking changes. The containment design is untouched: the closing guard,
its release gates, and the coordination state machine transitions behave
exactly as before — classification metadata, advisory emission, and
operator-facing text were added (the new metadata is mutated by the
settlement lifecycle, which is what flips an entry from the settle-wait
contract to the stranded contract once a prior attempt settles).
`ensureSnapshotCoordinationReady`'s rejection messages are unchanged;
`retrySnapshotCoordinationInitialization`'s closing refusals now name the
origin and recovery (the reset-session-origin refusals keep the
`closing for reset-session` marker; the shutdown and in-flight refusals carry
`closing for host shutdown` / `closing for an in-flight /swarm reset-session`).

## Caveats

- The writer-path advisory is bounded to one emission per project root per
  stop episode (re-armed only when readiness succeeds again), with a hard cap
  of 256 tracked roots; beyond the cap, new roots fall back to the debug log.
- The advisory rides the `/swarm diagnose` deferred-warning buffer, which
  caps at 50 entries and appends a truncation sentinel when full — "always
  visible" means surfaced by `/swarm diagnose`, never chat-visible.
- An in-flight reset's closing window with no pending prior attempt
  deliberately stays silent — that window is transient and owned by the
  running command. (When a prior initialization attempt is still settling,
  the writer's paused advisory does fire in that window.)
