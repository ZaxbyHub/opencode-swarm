# Route-receipt hardening: call-scoped invalidation registry, fail-closed binding reads, per-task read isolation

Issues #3509 and #3516 (collated trace `3509-3516-route-receipt-hardening`).

## What changed

- **New route-invalidation registry** (`src/review/route-invalidation-registry.ts`):
  a process-local `Map<canonicalDir, Map<sessionID, Map<callID, {taskKeys,
  callFault}>>>`. A reviewer/test_engineer dispatch whose routing faults
  BEFORE its pending receipt persists now records a whole-call fault marker
  (plus the per-task routing key when the task was resolved) — closing the
  #3509 gap where a pre-assignment fault recorded nothing and a stale prior
  receipt could authorize the failed dispatch's Stage-B settlement. The marker
  blocks every verdict task of the call at every enforcement seam that
  consults it, regardless of disk state.
- **Every seam consults.** The foreground `toolAfter` settlement loop, the
  background ingestion admission and completeness reads, the
  parent-unavailable recovery arm, and `applyStageBStateCompletion`'s
  completion/advancement decisions all consult the registry before
  authorizing advancement. Route-refusal and parent-unavailable invalid
  returns in the background ingestion are now TERMINAL drops
  (`{ok:false, consumed:true}`) instead of retryable, and the completion
  observer commits them durably (the commit predicate is
  `applied.ok || applied.consumed`).
- **Fail-closed corruption reads.** `readPrReviewReentryBindingContextSafe`
  rethrows the persistence layer's deliberate `BLOCKED:` corruption refusals
  (previously swallowed to null, which skipped the PR-review re-entry
  admission machinery entirely) and degrades only genuine fs faults, with a
  bounded, home-path-redacted warn on the always-emitted `CRITICAL-WARN`
  channel.
- **Per-task receipt-read isolation.** Both receipt-enforcement reads in the
  settlement loop are wrapped per task: a non-ENOENT read fault (POSIX
  ENOTDIR beneath a file-ancestor, corruption refusals) drops THAT task with
  the new `route_read_fault` drop class while sibling tasks in the same
  settlement still settle.
- **Sibling-clobber window closed.** `rememberReviewRoute` stamps the writer
  callID and enforces kind-monotonicity: a PENDING or router-error record from
  one callID can no longer overwrite a live FULL receipt written by a
  different callID. The dead task-scoped `forgetReviewRoute` is removed (it
  was a no-op at its only call site — the failed dispatch never remembered a
  record; see the erratum fragment).
- **Loud capacity semantics.** The registry never evicts: at
  `MAX_LIVE_CALLS_PER_SESSION=256`, `MAX_LIVE_SESSIONS_PER_DIRECTORY=128`, or
  `MAX_LIVE_DIRECTORIES=64` the RECORD operation fails, `criticalWarn` names
  the bound, and the routing catch REJECTS the dispatch with
  `ROUTE_INVALIDATION_CAPACITY` (fail-closed admission — a bounded
  availability trade: an unprotected dispatch is worse than a refused one).
  Records retire at terminal outcomes (settlement loop end, denied calls,
  failed outputs, the background observer's confirmed consumed commit) and
  empty containers are pruned, so settled traffic leaves no residue.

## Migration / caveats

- **Narrowed invariant surface (disclosed).** The "every seam applies the
  invalidation refusal" claim is narrowed to the gate settlement surfaces
  that carry a callID: the delegation-gate settlement loop, the background
  stage-b-gates ingestion/completion sites, and the completion observer.
  `src/tools/update-task-status.ts` (both enforcement reads) has no callID to
  consult with; its route enforcement is unchanged and the residual is
  disclosed here rather than plumbed through (callID plumbing was evaluated
  and rejected as a design change out of proportion to the advisory surface).
- **`legacy_unrouted` carve-out.** Tasks whose durable task-gate requirements
  predate route receipts (a legacy receipts chain with no route binding)
  remain authorized under the pre-v1 `legacy_unrouted` path. The new
  invalidation consults do not change that carve-out.
- **AC6 monotonicity substitution.** Issue #3516's AC6 wording ("forget
  deletion reddens") is reconciled to the shipped design: the forget is
  removed as DEAD code, and the live protection is the remember-monotonicity
  guard, whose deletion reddens the shipped interleaving legs. The mutation
  probe deletes the guard (the live mechanism), not the removed forget.
- **Best-effort capacity pre-flight.** The PRR-009 pre-flights before the
  one-use re-entry reservation remain, restated as best-effort across the
  reservation await: a concurrent dispatch admitted during the await can
  still trip the remember-time `STAGE_B_CONTEXT_CAPACITY` throw and burn the
  consumed token in that window. The pre-flight narrows the window; it does
  not close it.
- **Erratum.** `docs/releases/pending/3509-3516-route-receipt-erratum.md`
  corrects the v7.200.11 hardening narrative (mis-attribution to the
  in-memory forget, omitted per-callID invalidation and
  `ROUTE_RECEIPT_INVALIDATED` drop, omitted #3509 caveat, false
  "proven at the settlement entry point" claim, stale #3499 sentence).

## Testing

New suites: `tests/unit/hooks/review-route-settlement-3509.test.ts` (real
`toolAfter` settlement-integration legs, real-call-site enforcement legs,
single-instance cross-dispatch + monotonicity interleavings),
`review-route-hardening-legs-3516.test.ts` (capacity pre-flight, registry
consumption/no-eviction/retention, sibling-clobber, runtime warn channel and
redaction), `review-route-seams-3509.test.ts` (background seam consults,
block-only semantics, the real-observer durable-commit retirement, the
preserving no-task control, the update-task-status narrowed-contract pin),
`review-route-enotdir-3509.test.ts` (per-task read-fault isolation), and the
restructured `delegation-gate-review-route-persist-failure.test.ts` (a
majority of discriminating legs; the persist attempt is observable through a
DI seam).
