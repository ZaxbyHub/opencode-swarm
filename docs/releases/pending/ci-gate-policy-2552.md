# CI gate policy decision record (#2552)

## What changed

- Made integration discovery recursive so nested language integration tests run
  in CI, and recorded the Stage-D baseline and explicit merge-queue decisions
  in `docs/ci/merge-queue-policy.md`.
- Cleaned up the cross-contamination warning language so a known baseline
  warning remains diagnostic while a newly introduced regression remains
  blocking; the policy decision is recorded alongside that distinction.
- Documented the C9 post-land receipt schema and the requirement for three
  receipts per stage before closure.

The documented decisions retain `cancellation=false`, the 90-minute status
check timeout, build concurrency 5, and `ALLGREEN` / only-non-failing merge
eligibility. The workflow change is limited to recursive integration discovery;
it does not change branch protection or claim a Windows implementation.

## Why

The post-#2551 evidence window (2026-09-03T21:55:18Z through
2026-09-05T23:27:21Z) recorded 15 failures in 48 samples, zero cancellations,
zero same-reference overlaps, and an observed concurrency peak of 3. Recording
the decision boundary makes the Stage-D integration evidence auditable without
weakening the required gates.

## Migration

None for runtime or configuration. Any future queue or branch-protection change
must first pass the host check-name gate and collect three C9 receipts for each
stage.

## Breaking changes

None. Existing timeout, concurrency, cancellation, and `ALLGREEN` semantics are
preserved.

## Caveats

- Recursive discovery can reveal a previously unwired nested integration
  failure; that failure should be fixed or quarantined under existing policy,
  not hidden by restoring the depth cap.
- The Stage A Windows10 decision is planned separately and is not landed here.
- The baseline reports account concurrency as unknown, and the Windows timing
  figures are observational evidence rather than a Windows implementation
  claim.
