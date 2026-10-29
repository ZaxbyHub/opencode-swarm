---
issue: "3380"
---

## Delegation gate: route-receipt persist failure no longer skips the ACCEPTANCE and TASK gates

Fixes #3380 (carved out of the collated trace `3495-rmdir-scope-denial-gaps`;
the #3495/#3345 scope of that trace is being delivered by PR #3499).

In `createDelegationGateHook().toolBefore`, the reviewer/test_engineer routing
block's catch arm executed a bare `return;` when the route receipt could not
be persisted (`routeDispatchStarted` never set) — exiting toolBefore entirely
and silently skipping the dispatch-time gates below it. Reachable without
exotic faults: ENOTDIR / EACCES on `.swarm`, read-only filesystems,
project-root rejection.

The catch arm now keeps its warn and falls through, so the dispatch-time gates
always run: the reviewer ACCEPTANCE gate (coder dispatches never enter the
routing block; test_engineer has no ACCEPTANCE gate) and the whole
TASK_GATE_AGENTS block. The PR-review re-entry binding context re-reads in the
TASK_GATE block degrade locally the same way (an unreadable context is the
same "no binding" value the ENOENT path returns), so a routing-surface fs fault
never rejects the whole `toolBefore` with a raw fs error. Stage-B advancement
stays fail-closed on the missing receipt under the default
`review_routing.enforce_receipts: true` — proven at the settlement entry point
(`enforcePersistedReviewRouteReceipt` refuses advancement with the
route-required marker set and no receipt; `enforce_receipts: false` returns
`canAdvance: true`, the documented rollback shape).

Two hardening fixes from the PR's own review round: a failed persist now
forgets the previous dispatch's in-memory route record for the task (a stale
receipt could otherwise authorize the failed dispatch), and the Stage-B
capacity fence is pre-flighted BEFORE the one-use PR-review re-entry
authorization is consumed (a capacity refusal can no longer burn the token).
The durable Stage-B binding write is skipped vacuously for dispatches with no
bound tasks instead of emitting a false "binding write FAILED" alarm.

New suite `tests/unit/hooks/delegation-gate-review-route-persist-failure.test.ts`
(8 tests + 2 enforcement proof legs): deterministic persist failures
(`.swarm/pr-review` as a plain file with a readable plan.json — every
`.swarm` read stays ENOENT-tolerated on every matrix OS), receipt
presence/absence assertions proving the persist actually ran or failed, an
exact-code TASK-gate pair, a route-success leg persisting a real route receipt
(`kind: review_route_receipt`) for a task-attributed reviewer dispatch, and
the settlement-level Stage-B fail-closed proof.
