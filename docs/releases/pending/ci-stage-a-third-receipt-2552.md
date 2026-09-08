# CI: third Stage-A merge-queue receipt recorded (Issue #2552)

## What changed

- Recorded the third and final qualifying Stage-A post-land receipt in
  `docs/ci/merge-queue-policy.md`: Actions run `34162959243` (PR #2636's
  merge-group run, created 2026-09-07T21:23:29Z, full CI matrix with all six
  Windows unit shards executed, `run_duration_ms=2113000`, terminal
  merge/remove timeline pair with no intervening re-add). The run post-dates
  both the Stage-A publication (PR #2624) and the event-scoped cancellation
  change (PR #2632), so recording it completes the issue's checked-in C9
  receipt contract (three qualifying full-matrix receipts per stage) for both
  stages; receipt 3 also post-dates the last #2552 code change (PR #2632) for
  attributability.
- Updated the pinned Stage-A policy test
  (`tests/unit/scripts/ci/ci-stage-a-policy-2552.test.ts`) from the
  two-receipt pending state to the closed three-receipt state: the pending
  phrase is now a ratcheted absence, the injection guard is replaced by
  presence assertions, and the receipt table carries the third entry.
- Reconciled the two earlier pending release fragments
  (`ci-gate-policy-2552.md`, `ci-stage-a-decision-2552.md`) that still
  described the third Stage-A receipt as pending: their wording is now
  past-tense-at-publication with an explicit pointer to run `34162959243`,
  so the aggregated release notes cannot contradict the closed state.

## Why

Issue #2552's checked-in C9 receipt contract requires three qualifying
full-matrix receipts per stage as post-land closure evidence, and the issue
author's closure comments track exactly that residual. Stage-D had three;
Stage-A had two and the policy record explicitly kept the issue open on the
missing third. The qualifying run existed on GitHub Actions; recording it
completes the C9 contract for both stages, with receipt 3 collected after the
last #2552 code change (PR #2632) for attributability. No workflow, ruleset,
or policy change is involved.

## How to use

No runtime or configuration migration. `docs/ci/merge-queue-policy.md` is now
the complete six-receipt decision record; future queue or branch-protection
changes still start from a fresh host check-name gate and C9 receipt set.

## Caveats

- `queue_wait_ms=unavailable` remains honest: no canonical run-level
  runner-wait aggregation exists for these receipts.
- The retain-six Stage-A decision, 90-minute timeout, build concurrency 5,
  `ALLGREEN` eligibility, and the Windows-ten reopening gate are unchanged.
