<!--
Erratum: corrects the v7.200.11 release narrative (docs/releases/v7.200.11.md,
"Delegation gate: route-receipt persist failure no longer skips the ACCEPTANCE
and TASK gates"). Decision recorded on issue #3516 (in-repo erratum fragment,
the lightest option of the three considered). Delivered by the
3509-3516-route-receipt-hardening PR.
-->

# Erratum: v7.200.11 route-receipt hardening narrative

The v7.200.11 fragment described the #3380 fix's hardening layer with five
inaccurate claims. The delivered behavior (verified at the release commit and
re-verified by the 3509-3516 trace at `bf65b6efb`) is corrected below.

1. **Mis-attribution to the in-memory forget alone.** The fragment said "a
   failed persist now forgets the previous dispatch's in-memory route record
   for the task (a stale receipt could otherwise authorize the failed
   dispatch)". The forget was a no-op at its only call site: the dispatch
   whose persist failed never remembered a record (the persist failed first),
   so the slot's in-memory record always belonged to a PRIOR dispatch, and
   deleting the forget was proven suite-green by the #3516 mutation probes.
   What actually withheld the failed dispatch's settlement was the
   per-callID invalidation record — which the fragment omitted entirely. The
   follow-up PR (#3509/#3516) removes the dead forget and replaces the
   per-hook-instance invalidation map with a process-local registry.

2. **Omitted the `ROUTE_RECEIPT_INVALIDATED` settlement drop.** The fragment
   never mentioned that a settlement consult drops the failed dispatch's
   Stage-B settlement with the `route_blocked` reason class. That drop — and
   its enforcement half being unpinned by the shipped suite (the suite never
   called `toolAfter`) — is the subject of #3516 items 2, 3, and 8.

3. **Omitted the #3509 caveat.** The per-callID invalidation was recorded only
   when `routedTaskId` was already assigned. A routing fault BEFORE task
   resolution (including corrupt gate state that makes the routing block's
   raw read throw) recorded nothing, so a stale prior receipt could authorize
   exactly the dispatch the fix was meant to fence. #3509 tracks this; the
   follow-up PR records a whole-call fault marker for every pre-persist
   routing fault.

4. **False "proven at the settlement entry point".** The fragment claimed
   Stage-B fail-closure was "proven at the settlement entry point". The proof
   actually called `enforcePersistedReviewRouteReceipt` directly from the test
   — the REAL settlement call site (wired from
   `config.review_routing.enforce_receipts`) was never executed by the suite,
   and mutating the call site left the suite green (#3516 item 3). The
   follow-up PR pins the real call site through the real `toolAfter`
   settlement path.

5. **Stale "#3499 is being delivered" sentence.** PR #3499 had already merged
   before v7.200.11 was published; the sentence read as if the sibling work
   were still pending. It is deleted here.

The empty-binding-skip claim in the same fragment was accurate as written but
unpinned (deletable with the suite green); the follow-up PR pins it with a
leg whose removal reddens the suite. The capacity pre-flight claim ("a
capacity refusal can no longer burn the token") was overstated — the follow-up
PR pins the pre-flight with its own leg AND restates it as best-effort across
the reservation await: a concurrent dispatch admitted during the await can
still trip the remember-time capacity throw and burn the consumed token in
that window (the pre-flight narrows the window; it does not close it).
