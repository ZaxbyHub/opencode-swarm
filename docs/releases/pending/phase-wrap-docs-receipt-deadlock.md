# Fix: phase_complete no longer deadlocks on a docs run dispatched at PHASE-WRAP

## What

`phase_complete(N)` now accepts the docs participation receipt from the
phase-wrap flow. The phase-wrap skill completes phase N's last task first, and
that advances the plan's `current_phase` cursor to N+1. The docs agent is
dispatched after that, so its receipt is stamped N+1. The gate only accepted a
receipt tagged with N or with a cursor *behind* N. It rejected this one with
`REQUIRED_AGENTS_MISSING`, and every re-dispatch stamped N+1 again, so with the
default `require_docs: true` / `enforce` policy the phase could not complete.

A receipt tagged with the plan's current cursor now satisfies phase N only in
that wrap window:
- every task of phase N is completed or closed;
- the cursor is later than N in plan order — usually N+1, or further ahead
  when every phase in between was closed without work (see
  `isPhaseInWrapWindow` below).

The `phase_complete` success path re-stamps the receipt to N, as it already did
for a lagging cursor, so phase N+1 still needs its own docs run. A receipt
ahead of N is still rejected when it is not tagged with the current cursor,
when a phase with completed work lies between N and the cursor, or while
phase N still has open tasks. A structural plan edit still invalidates every
receipt. If the re-stamp cannot run (the plan or the participation store
cannot be read after the transition), it is retried once and then reported
as a `phase_complete` warning telling the architect to dispatch docs again
for the next phase.

## Why

Found in a live run: the architect followed the phase-wrap skill and was
blocked three times at `phase_complete`, with no way forward.

The same cursor advance blocked `record_directive_override`, the recovery
`phase_complete` hands out when the critical-directive gate blocks phase N:
it required phase N to be the current phase, which it no longer is at
PHASE-WRAP, so the override was always refused. It now also accepts the phase
being wrapped and records the override under that phase's own label. Both
checks share one rule (`isPhaseInWrapWindow`): phase N's work is done, the
cursor is later in plan order, and every phase in between was closed without
work. A phase with completed work in between has its own wrap, so a docs run
or override never stands in for an older phase.
