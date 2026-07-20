# Failover test coverage and reviewer-timeout classify alignment

## What changed

- The critic-oversight failover loop (`src/full-auto/oversight.ts`) and the
  evaluation dispatcher's same-model quota retry (`src/evaluation/model-dispatcher.ts`)
  are now covered by focused tests (`tests/unit/full-auto/oversight-fallback.test.ts`
  and the new cases in `tests/unit/evaluation/model-dispatcher.test.ts`). The
  oversight loop is bespoke (it does not use the shared `dispatchWithModelFallback`
  helper that the lean reviewer and lane runner use), so it was previously
  untested — these tests pin the quota-failover recovery, the `critic_model`
  attribution rewrite, the `telemetry.modelFallback` signal, the
  increment-before-parse malformed-entry skip, the `critic_oversight`→`critic`
  fallback inheritance, and the permanent-error fail-closed path. The evaluation
  tests pin the retry-NOT-substitute invariant (benchmark attribution), session
  cleanup between retries, the enriched error string, and the permanent-error
  no-retry path.
- The lean-turbo reviewer's model-fallback classifier now explicitly treats a
  reviewer dispatch timeout as permanent. This aligns it with the lane runner's
  defense-in-depth carve-out, guaranteeing a reviewer dispatch timeout can never
  be misread as a transient provider error even if the timeout message is reworded
  in the future (today's "Reviewer dispatch timed out" message already does not
  match the transient classifier, so timeouts already fail closed — this is a
  hardening/alignment change, not a behavior fix).

## Migration

No configuration change and no behavior change. The reviewer-timeout carve-out is
defense-in-depth: the current "Reviewer dispatch timed out" message never
classified as transient (the classifier matches `timeout`, not the spaced
`timed out`), so a reviewer timeout already failed closed to a REJECTED verdict
before and after this change. The new carve-out pins that behavior against a
future timeout-message rewording that would otherwise match.

Review feedback on PR #1901 (#1896 closure).
