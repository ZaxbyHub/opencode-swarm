# Background Delegations: Durable Ingestion Commit as a Recoverable Closeout Step

## What

Fixes the "settled but stranded" background-delegation wedge observed on
long-running swarm evenings (consumer project, 2026-11-27, task 3.8): a coder
round whose trusted terminal was claimed and settled, but whose terminal-result
ingestion apply/commit failed once, was unrecoverable in-band and eventually
lost its result to the stale sweep.

Layer 23 makes the durable terminal-result ingestion its own recoverable
closeout step:

- `ingestion_commit` is a required closeout step for the ingestion-claim set
  (coder and gate-bearing rounds with a completed trusted terminal). It is
  acked ONLY when the ingestion commits durably (`consumed` — success or a
  terminal-negative outcome); every failure arm (failed apply, fenced claim,
  unconfirmed commit) leaves it pending so the r13 recovery re-drive replays
  the trusted terminal on every maintenance pass until the ingestion commits.
- The automatic liveness stale sweep no longer flips a record whose ingestion
  is live or recoverable (`claimed`/`retryable`). Previously the sweep
  overwrote the trusted terminal with the liveness-stale terminal, after which
  `claimDelegationIngestion` refused the record forever (`not_ready`) — the
  round's result was stranded, the settlement WAL window blocked re-dispatch,
  and the only exit was out-of-band salvage plus a human `/swarm recover`.
  Authorized operator finalizations (failureClass/reasonPrefix overrides,
  e.g. `/swarm abort-pr-workflow`) still terminalize deliberately (#2971
  scoping).
- Legacy journals (initialized before the step existed) are upserted on
  replay: a same-terminal `initializeTerminalCloseout` re-drive ADDS missing
  required steps as pending while preserving every existing step state, and
  such records stay in the recovery set until their ingestion is durably
  consumed.
- A crash between the durable consumed commit and the step ack is healed by
  the next replay: the consumed-disposition path acks the step without
  re-applying the ingestion.
- The journal-gate contract (r14 P0-2) is preserved: when journal
  initialization fails, every journal-gated ack — including `ingestion_commit`
  — is deferred to recovery instead of forging a fragment journal.
- The re-drive is bounded. A deterministic ingestion failure (for example a
  stale workspace on replay) can never commit, so after
  `MAX_INGESTION_REDRIVE_ATTEMPTS` (5) failed claims the observer stops
  claiming, marks `ingestion_commit` failed with a visible reason (r14
  terminally-closed semantics), closes the same parent-advisory/context-map
  steps the failed-apply arm closes, and the sweep immunity ends: once the
  record ages, the stale sweep flips it exactly as it did before this change.
  A transient failure is recovered only if it clears within that budget; the
  re-dispatch of the task is the exit for an abandoned ingestion. The record
  leaves the recovery set only once its other closeout steps are closed, and a
  sweep-flipped record (new terminal event id) stays an inert recovery
  candidate, which is existing behavior this change does not alter.
- Compatibility: `ingestion_commit` is a new key in the strict closeout step
  schema, and every coder or gate-bearing record written by this release
  carries it. A plugin older than this release (7.205.12 or earlier) that reads
  such a delegation journal rejects the record, which makes the whole
  delegation store read as uncertain on the SQLite authority path: its
  delegation reads return nothing and its delegation writes do nothing (fails
  closed, no data loss). Roll back only together with a drained/closed
  delegation store; this matches the earlier additive `closeout` field, which
  also shipped without a schema bump.

## Why

Without the pending trigger, a single failed ingestion apply left the record
with every journaled step completed — the r13 closeout recovery never fired —
and the stale sweep then destroyed the trusted terminal, converting a
transient failure into a permanent, manually-recoverable-only loss of the
round's result.

## Verification

- New suites `tests/unit/background/background-delegation-ingestion-commit-closeout.test.ts`
  (observer ack and recovery paths, including an observer-driven commit-failure
  arm, the crash-heal replay asserting no re-apply, and a negative test that a
  non-coder non-gate record gets no step) and
  `tests/unit/background/background-delegation-ingestion-commit-sweep.test.ts`
  (sweep immunity, #2971 operator-override scoping, the bounded give-up and the
  recovery-set predicate boundaries). Shared fixtures live in
  `tests/helpers/ingestion-commit-fixtures.ts`.
- The suites are designed to fail if the sweep guard, the required step, the
  ack, or the attempt budget is removed.
