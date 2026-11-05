---
issue: [3564, 3494]
---

# Route-invalidation markers can no longer leak; recovery-claim merge-backs land in the requested shape

## What

Two dispatch-lifecycle correctness fixes land together:

- Every recorded route-invalidation marker now retires through a structurally
  guaranteed mechanism. A retirement obligation is registered at admission
  inside the registry, every retirement path discharges it, and a
  `toolAfter`-level `finally` flushes whatever remains unless the call's
  ownership was deliberately deferred to the completion observer (a durable,
  live, gate-bearing, observer-consumable pending record). The
  pending-delegation stale sweep and the completion observer's terminal arm
  discharge swept/terminal records, so silent leaks can no longer accumulate
  toward the fail-closed `ROUTE_INVALIDATION_CAPACITY` wedge. The capacity
  refusal message now distinguishes live-call occupancy ("settle or retire
  them") from leaked markers whose calls already ended ("restart the plugin
  or run /swarm close"), so operators facing the wedge know which remedy
  applies.
- A claimed recovery lane now threads the dispatch's landing intent into
  `recoverMergeBackFromImmutableCoordinates` with the same mapping as the
  reconciliation path: a `merge`-strategy recovery without a commit landing
  lands `squash-unstaged` (changes unstaged in the primary working tree, HEAD
  unmoved, preserved ref retained) instead of always landing a merge commit;
  an epic or caller commit landing lands as a commit carrying that message.
  An epic dirty-index refusal fails preserved before the provenance callback,
  mirroring the non-claim arm.

## Why

Retirement of route-invalidation markers was a set of plain statements
scattered across `toolAfter`; three code paths (background-correlation
catch, unparseable running placeholder, no-session early returns plus the
stale-session-sweep interleaving) had no reachable retirement owner at all,
silently accumulating dead occupancy until every faulted dispatch was
refused. Separately, the recovery-claim path always passed no landing
options, so whether an interrupted coder's work landed as a merge commit or
left the work unstaged for review depended on whether the interruption
happened — not on what the dispatch requested.

## Notes

The pending-delegation stale-sweep discharge supersedes one Out-of-scope
bullet of issue #3564 ("retiring markers on the stale sweep"): that bullet's
own rationale — post-sweep settlement is claim-fenced — is exactly what makes
sweep-time retirement safe (a swept record can never consult its marker
again), while leaving swept markers is the accumulating leak the issue
exists to close. The state.ts agent-session sweep remains untouched per the
issue. Disclosed by the plan critic round 2 and carried into this change.
