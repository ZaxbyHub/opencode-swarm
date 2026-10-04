# Fix: phase_complete no longer deadlocks on a docs run dispatched at PHASE-WRAP

## What

`phase_complete(N)` now accepts the docs participation receipt from the
phase-wrap flow. The phase-wrap skill completes phase N's last task first, and
that advances the plan's `current_phase` cursor to N+1. The docs agent is
dispatched after that, so its receipt is stamped N+1. The gate only accepted a
receipt tagged with N or with a cursor *behind* N. It rejected this one with
`REQUIRED_AGENTS_MISSING`, and every re-dispatch stamped N+1 again, so with the
default `require_docs: true` / `enforce` policy the phase could not complete.

A receipt tagged N+1 now satisfies phase N only in that wrap window:
- the plan cursor is still exactly N+1;
- every task of phase N is completed or closed.

The `phase_complete` success path re-stamps the receipt to N, as it already did
for a lagging cursor, so phase N+1 still needs its own docs run. A receipt two
or more phases ahead, or one recorded before phase N's work was finished, is
still rejected. A structural plan edit still invalidates every receipt.

## Why

Found in a live run: the architect followed the phase-wrap skill and was
blocked three times at `phase_complete`, with no way forward.
