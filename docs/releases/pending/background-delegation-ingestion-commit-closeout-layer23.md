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
- A pending `ingestion_commit` step on a flipped (non-completed) terminal
  drops out of the recovery set (it can never progress); a step durably marked
  `failed` (r14 terminally-closed semantics) also drops out.

## Why

Without the pending trigger, a single failed ingestion apply left the record
with every journaled step completed — the r13 closeout recovery never fired —
and the stale sweep then destroyed the trusted terminal, converting a
transient failure into a permanent, manually-recoverable-only loss of the
round's result.

## Verification

- New suite
  `tests/unit/background/background-delegation-ingestion-commit-closeout.test.ts`
  (8 tests) pins all surfaces: fresh-completion ack, wedge state + sweep
  immunity, duplicate-delivery re-drive, legacy-journal upsert + candidate,
  crash-between-commit-and-ack healing, sweep scoping (#2971 operator
  override), and the pure recovery-set predicate boundaries.
- Both new-behavior surfaces were falsified (guard removed → sweep test
  fails; required step removed → four ack tests fail) and restored.
