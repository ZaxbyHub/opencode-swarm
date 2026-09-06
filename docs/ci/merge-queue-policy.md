# Merge-queue CI policy — Stage D decision record (#2552)

## Status and scope

**Record date:** 2026-09-06
**Evidence:** post-#2551 baseline, 2026-09-03T21:55:18Z through
2026-09-05T23:27:21Z.

This document accompanies the Stage-D recursive integration and gate-hygiene
changes for issue #2552. It records what the observed data supports and what
remains deliberately unchanged. The Stage-D workflow change makes integration
test discovery recursive; this record does not change branch protection,
merge-queue settings, or runner implementation.

The retained policy is:

- `cancellation=false`, because the current sample has zero same-reference
  overlap and zero cancellations;
- a `timeout=90m` status-check timeout;
- `build_concurrency=5`; and
- `ALLGREEN` / only-non-failing merge eligibility.

The Stage A Windows10 decision is planned separately. No Windows implementation
is landed or claimed by this record.

## Post-#2551 baseline

The baseline window is **2026-09-03T21:55:18Z through
2026-09-05T23:27:21Z**. The outcome sample contains 48 samples from 50 attempts;
the attempt count is retained separately so that retries and duplicate
references are not silently folded into the outcome denominator.

| Measure | Observed value |
| --- | --- |
| Sample outcomes | success 33; failure 15; cancelled 0 |
| Attempts | 50 |
| Duplicate references | 5 |
| Same-reference overlaps | 0 |
| Windows marker | `last22/33` |
| Account concurrency | unknown |

Baseline shorthand: `sample48 success33 failure15 cancelled0 attempts50 duplicate-ref5 same-ref overlaps0`.

Durations below are in minutes unless a field explicitly says otherwise.

| Duration | Average | P50 | P95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| `run_duration` | 26.97m | 32.55m | 46.65m | 53.05m |
| `created - updated` | 28.43m | not reported | 51.42m | 61.45m |

The total billable duration was `total_ms=0`.
For audit tooling, the compact duration records are `run_duration avg26.97m p5032.55 p9546.65 max53.05` and `created-updated avg28.43 p9551.42 max61.45`.
The compact Windows records are `Windows last22/33 tail avg8.29 p509.05 p9513.97 max17.12` and `first Windows start proxy avg2.77 p501.78 p959.98 max12.35`.

The Windows tail was **average 8.29m, P50 9.05m, P95 13.97m, maximum
17.12m**. The first Windows start proxy was **average 2.77m, P50 1.78m,
P95 9.98m, maximum 12.35m**.

Failure classes were `rust=7`, `windows-unit=1`, and `coverage=7`. These
classes account for all 15 observed failures; the account-level concurrency
limit was not available, so the data cannot establish a provider throttle.

## Explicit decisions

### Status check timeout

**Decision:** retain the 90-minute timeout.

The observed maximum `run_duration` was 53.05 minutes and the maximum
`created - updated` interval was 61.45 minutes. The existing 90-minute value
therefore leaves operational margin without treating the measured tail as a
reason to relax a required check.

**Expected benefit.** Preserve enough headroom for a slow merge-group run while
avoiding an open-ended wait in the queue.

**Preserved gates.** Required checks still have to report a passing result, and
the host check-name gate remains authoritative for the exact names emitted by
the host, including matrix-leg names where applicable.

**Validation.** Recompute the timeout comparison over the next post-land
window: record the maximum `run_duration` and `created - updated` values, then
check that every required check settled before 90 minutes. Attach the C9
receipts described below rather than treating a dashboard view as proof.

**Rollback.** If a later, approved baseline shows that 90 minutes is
insufficient, change the policy through a new decision record after reviewing
the host check-name evidence. Do not widen the timeout as an unrecorded
workaround for a single run.

### Build concurrency

**Decision:** retain build concurrency at 5.

The observed peak was 3. Reducing the configured value to 1 or 2 would have
throttled observed demand without proven relief, while the account concurrency
limit is unknown. The evidence supports retaining 5 until a bounded experiment
can separate queue pressure from provider-side throttling.

**Expected benefit.** Keep the current throughput envelope and avoid adding
avoidable queue delay while preserving a conservative cap.

**Preserved gates.** Concurrency is only a scheduling limit; it never weakens
the required-check, `ALLGREEN`, or cross-contamination gates. A queued run
remains subject to the same timeout and failure handling.

**Validation.** On the next evidence window, capture observed peak concurrency,
queue wait, eviction, and the host/account limit if it becomes available. A
change is supportable only when those measurements show both the pressure and
the relief from a different cap.

**Rollback.** If a future bounded experiment at another cap increases queue
wait, evictions, or failure rate, restore concurrency 5 and retain the existing
required-check policy.

### Only merge non-failing

**Decision:** retain `ALLGREEN` / only-non-failing merge eligibility.

Fifteen of the 48 sampled outcomes failed. That failure rate is sufficient
evidence to keep a failing required check blocking the queue; it is not a basis
for a green-by-retry or partial-success exception.

**Expected benefit.** Prevent a merge-group candidate with a known failing
required check from being treated as safe merely because another check passed.

**Preserved gates.** Every required host check must pass, exact check names must
be matched by the host check-name gate, and cross-contamination regressions stay
blocking. A known, separately recorded warning is not permission to ignore a
new regression.

**Validation.** For each post-land window, reconcile the outcome count with the
required-check conclusions and record any failure class. The decision remains
valid while failures are visible and non-failing candidates alone are eligible
to merge.

**Rollback.** Do not relax this decision through an emergency queue setting. If
the failure evidence is later shown to be a measurement defect, amend this
record with the corrected evidence and an explicit gate review before changing
eligibility.

### Cancellation

**Decision:** retain `cancellation=false`.

**Expected benefit.** Avoid changing cancellation behavior when the evidence
shows no current same-reference overlap and no cancelled samples.

**Preserved gates.** Cancellation remains independent from the required-check
and `ALLGREEN` decisions; a cancelled or evicted run cannot be reclassified as
passing.

**Validation.** Continue recording cancellations and same-reference overlaps
in each evidence window. A non-zero overlap must be reviewed as a new decision,
not inferred from this zero-overlap baseline.

**Rollback.** If a future, attributable overlap is demonstrated, revisit the
setting in a follow-up decision record with receipts and a bounded experiment.

## Host check-name gate and the planned Stage A decision

The host check-name gate is a prerequisite for any merge-queue or branch-
protection decision: inspect the names emitted by the host for the exact commit
and compare them with the required-check configuration. Matrix jobs must be
matched by their emitted leg names; an assumed aggregate name is not evidence.
Record the host/version, event, commit, and observed names with the decision.

The Stage A Windows10 decision is planned separately and is not landed by
#2552's Stage-D record. This document records only the gate that must protect
that future decision and the observed Windows timing baseline. It makes no
claim that Windows10 support, a Windows workflow change, or a Windows
implementation has shipped.

## C9 post-land receipt contract

C9 receipts are individual structured records, not synthetic summary rows. The
identifier form is `stage-{d,a}-post-land-N`; `N` identifies one receipt in
the stage's closure set. The exact fields are:

```text
identifier=stage-{d,a}-post-land-N
actions=URL
run_duration_ms=<integer>
queue_wait_ms=integer|unavailable
eviction=<recorded value>
completed_at=ISO Z
```

Closure requires **3 receipts per stage**: three Stage-D receipts and three
Stage-A receipts. A stage is not closed by a partial set, a dashboard screenshot,
or a receipt that omits `queue_wait_ms` instead of using the literal
`unavailable` value.

## Cross-contamination warning language

The decision record uses two distinct outcomes: a newly introduced
cross-contamination regression is blocking, while a known pre-existing warning
is diagnostic and remains explicitly labeled with its known baseline. This
cleanup prevents a warning from being mistaken for either a clean run or a new
regression. The distinction does not waive the test gate or change the
underlying check.

## Caveats, migration, and breaking changes

### Caveats

- The outcome denominator is 48 samples while the attempt count is 50; this
  record does not infer why the two counts differ.
- Account concurrency is unknown, so the concurrency decision is intentionally
  conservative rather than a provider-capacity claim.
- The Windows figures are observational timing evidence only. They do not land
  the separate Stage A Windows10 decision.
- The C9 contract requires three receipts per stage; missing receipts keep
  closure open.

### Migration

No runtime or configuration migration is required. Stage D makes integration
discovery recursive and removes obsolete scanner notices; before applying any
future queue or branch-protection change, perform the host check-name gate and
collect the required C9 receipt closure set.

### Breaking changes

None. The documented timeout, concurrency, cancellation, and `ALLGREEN`
semantics are retained. Recursive integration discovery adds coverage without
changing those gates, and no Windows implementation is claimed here.
