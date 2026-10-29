---
issue: "3380"
---

## Delegation gate: route-receipt persist failure no longer skips the ACCEPTANCE and TASK gates

Fixes #3380 (carved out of the collated trace `3495-rmdir-scope-denial-gaps`;
the #3495/#3345 scope of that trace is superseded by PR #3499, which ships it).

In `createDelegationGateHook().toolBefore`, the reviewer/test_engineer routing
block's catch arm executed a bare `return;` when the route receipt could not
be persisted (`routeDispatchStarted` never set) — exiting toolBefore entirely
and silently skipping the ACCEPTANCE gate (coder/reviewer) and the whole
TASK_GATE_AGENTS block below it. Reachable without exotic faults: ENOTDIR /
EACCES on `.swarm`, read-only filesystems, project-root rejection.

The catch arm now keeps its warn and falls through, so the dispatch-time
gates always run. Stage-B advancement stays fail-closed on the missing
receipt under the default `review_routing.enforce_receipts` (the routing
block's documented design): the persistence failure fails the routing
bookkeeping locally, never the whole `toolBefore`.

New suite `tests/unit/hooks/delegation-gate-review-route-persist-failure.test.ts`
(6 tests): deterministic persist failures (`.swarm` as a plain file for the
reviewer legs; `.swarm/pr-review` as a plain file with a readable plan.json
for the test_engineer legs), persist-OK controls, and positive route-success
legs — pinning that the gates run in both directions.
