# fix(background): the stale sweep measures observed child activity, not store-write age

## What

Closes the task 2.15 liveness wedge from a consumer project's
`.swarm/swarm_communication_debug.md` (2026-11-26, consumer-project).
The background delegation stale sweep flipped a `pending`/`running` record
to `stale` (failure class `liveness`) when its STORE `updatedAt` was older
than the sweep timeout — but a live child's activity never writes the
store: the record is written at dispatch and again only at its terminal.
Three consecutive coder rounds running JVM-coupled test suites were each
stale-swept at the 30-minute mark while actively working, delivered their
committed work seconds after the flip, and their settlements died with the
stale classification — no attribution, no `accepted_mutation`, the task
wedged at idle with a user-salvaged deliverable (same family as the 2.24
and 2.14 incidents).

The fix adds a process-local child-activity registry
(`src/background/child-activity.ts`, bounded per invariant 8, metadata
only — session id + event type, never payload text) fed by the v2 event
pump: every session-scoped envelope marks the child recently active;
`session.tool.called`/`success`/`failed` maintain an open-tool counter;
`session.execution.*` clears it. The sweep consults the registry before
flipping: a child with a recent event OR an open tool call (a single long
execution emits `called` at its start and nothing until it completes) is
alive and is not swept.

## Why

Store-write age is not liveness. The pre-fix semantics guaranteed that any
coder round running longer than the sweep timeout (default 30 minutes)
without an intermediate store write was classified dead while physically
alive — for long-running verification and test suites that is the normal
case, not the exception. Unknown/quiet sessions keep the historical
store-age semantics (fail-open, including hosts without an event pump),
and an operator-forced sweep (#2971 terminal stamping) bypasses the guard
— the audited operator decision wins.

## Verification

New suites: registry semantics 6/6 (an open tool call older than the
window still blocks — the exact 2.15 geometry — plus close/session_end,
window, unmatched closes, bounds), stale-sweep activity guard 4/4 (the
faked 2.15 arc: active child not swept, quiet child swept with the
historical `liveness` terminal, closed child swept after the window,
operator force bypasses), pump wiring 3/3 via the real `pumpEnvelopes`
harness. Sweep-adjacent suites 60/60; `tsc --noEmit` clean; `biome` clean.
Deployed to the consumer's production build and exercised the same day.
