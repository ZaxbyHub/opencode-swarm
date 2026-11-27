# A finished background coder no longer blocks every later coder dispatch

## What

A background coder delegation whose child session already produced its trusted
terminal event no longer counts as an *active* coder owner for admission
capacity, and the capacity reservation it held is now released on proof as
soon as the terminal is durable.

- `completed` (result waiting to be ingested by the parent) and
  `ingestion_error` (one ingestion attempt failed; the result stays durably
  claimable in the delegations store) are terminal **for the child**: the
  launch is finished and must not occupy a live slot.
- The shared background maintenance pass releases a bound reservation whose
  exact owner record proves the child finished — proof-based, no lease age
  involved. Previously such a record *renewed* the lease forever
  ("exact owner record still active"), so the reservation never went away.
- Admission (`reserveBackgroundCoderSlot`) reconciles the same proof inline,
  so the very next dispatch after a wedged launch is admitted again.
- Preserved settlements and worktree-holding records are unchanged: they own
  recoverable resources and still count as active.
- Checkpoint compaction semantics are unchanged — unconsumed terminal records
  still keep their full bodies (a separate, broader liveness predicate remains
  in place for compaction and health counts), so a released reservation never
  drops or truncates a pending result.

## Why

Observed in the wild (a long-running adoption-audit session): a background
coder finished its work — trusted terminal `completed`, settlement `settled` —
but the single ingestion attempt into the parent session failed, leaving its
delegation record in `ingestion_error` forever. The old admission/renewal
predicate counted that dead child as an active coder owner, so:

1. the reservation lease renewed at every maintenance pass, keeping the
   reservation alive indefinitely, and
2. with `maxConcurrent = 1` (the standard coder path), every later coder
   dispatch of that parent session was denied with `PARALLEL_SLOTS_EXHAUSTED`.

The only release path was the 30-minute stale sweep of the delegation record —
and nothing guaranteed the record would age out (any retry touching it resets
the timer). Net effect: one failed ingestion could stop all coder work of a
session permanently. The result itself was never lost; only the bookkeeping
wedged the capacity accounting.

## Migration

No action required. Sessions that are currently wedged in this state unblock
automatically on their next coder dispatch: the admission-time reconciliation
drops the provably idle reservation before counting capacity.
