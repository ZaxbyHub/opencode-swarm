# Merge-queue CI policy — Stage D and Stage A decision record (#2552)

## Status and scope

**Record date:** 2026-09-06
**Evidence:** post-#2551 baseline, 2026-09-03T21:55:18Z through
2026-09-05T23:27:21Z; current Stage-A window, 2026-09-03T21:57:31Z through
2026-09-06T22:14:18Z.

This document accompanies the Stage-D recursive integration and gate-hygiene
changes for issue #2552. It records what the observed data supports and what
remains deliberately unchanged. The Stage-D workflow change makes integration
test discovery recursive; this record does not change branch protection,
merge-queue settings, or runner implementation.

The retained policy is:

- event-scoped cancellation: `merge_group` runs may cancel a superseded run
  sharing the same queue ref, while `pull_request` and manual runs remain
  non-cancelling;
- a `timeout=90m` status-check timeout;
- `build_concurrency=5`; and
- `ALLGREEN` / only-non-failing merge eligibility.

The exact required-context contract is maintained in
`scripts/required-check-contract.json` and reconciled with the captured
GitHub evidence in `docs/ci/required-check-evidence.json`. The capture is
freshness-bound and the `required-check-contract` detector fails closed for
missing, stale, mismatched, renamed, or event-skipped required contexts. The
`drift` workflow now has a `merge_group: [checks_requested]` trigger, but
`drift` remains an intended-required notice until an authorized operator has
observed its merge-group runs and promotes it in active ruleset `17809658`.
The current capture deliberately separates facts: `captureSha` pins the
external workflow/event observation to base `b21cdce17b8731143ed5fab7fdf32dd8ad5f7a7f`,
where the pinned Contents blob for `drift-check.yml` has no `merge_group`, while
the proposed local workflow has the trigger and is checked by its separate
local hash. The capture includes concrete CI and PR Standards merge-group run
receipts `34639685905` and `34639685670`. Therefore the missing external drift
event is a visible nonblocking promotion divergence; missing events for any
already-required context remain blocking, and the local proposed workflow must
still carry the new trigger.

The merge-group release-please ride-along is intentional: the guard uses the
anchored head commit's release predicate, not the user who queued the group.
Pull-request owner-file edits additionally require the exact trusted actor
`github-actions[bot]`. The guard does not derive versioned release-note paths;
normal `docs/releases/pending/*.md` fragments remain valid.

The Stage-A retain-six decision is landed by this record for the current
evidence window. No Windows-ten implementation is landed; only a future
Windows-ten experiment remains unlanded and gated by the reopening criteria.

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

**Decision:** use `cancel-in-progress: ${{ github.event_name == 'merge_group' }}`.
Pull-request and manual runs evaluate to false; merge-group runs evaluate to
true when a newer head supersedes the same queue ref.

**Expected benefit.** Let a stale merge-group candidate release its shared queue
ref while preserving the pull-request check status behavior that motivated the
original non-cancelling safeguard.

**Preserved gates.** Cancellation remains independent from the required-check
and `ALLGREEN` decisions; a cancelled or evicted run cannot be reclassified as
passing.

**Validation.** Continue recording cancellations and same-reference overlaps in
each evidence window. A cancelled merge-group run must be paired with its newer
head and must not be counted as a passing required check. Pull-request and manual
runs must remain non-cancelling.

**Rollback.** If a cancelled merge-group candidate removes a live queue item or
leaves a stale required status, use a unique per-run concurrency group key
through a follow-up decision record with attributable receipts. Do not restore
unconditional cancellation settings without that scoped rollback decision.

## Host check-name gate and Stage A decision

The host check-name gate is a prerequisite for any merge-queue or branch-
protection decision: inspect the names emitted by the host for the exact commit
and compare them with the required-check configuration. Matrix jobs must be
matched by their emitted leg names; an assumed aggregate name is not evidence.
Record the host/version, event, commit, and observed names with the decision.

### Stage A decision window

The current Stage A evidence window contains **56 `merge_group` runs** from
2026-09-03T21:57:31Z through 2026-09-06T22:14:18Z: **39 successful and 17 failed**.
The merge-group run-duration tail was **P50 `30m36s`, P95 `51m25s`,
and maximum `58m47s`**. Retries and duplicate merge-group attempts remain
separately accounted for rather than being folded into the outcome count. The
Actions timing records report `total_ms=0` for the Ubuntu, Windows, and macOS
jobs; account-level concurrency capacity remains unknown, not zero.

Runner queue time is the interval waiting for a runner before a job starts.
The separately observed **39m41s** figure is end-to-end merge-group queue and
group/`ALLGREEN` serialization, not runner queue time and not a quantity that
Windows re-sharding can directly change. The sampled Windows runner queue
delay reached 6.7–14.7 minutes.

**Decision:** Retain six Windows unit shards for this evidence window as a
capacity/risk decision. The workflow remains six shards on Ubuntu, macOS, and
Windows (`shard: [1, 2, 3, 4, 5, 6]` and `num_shards=6`), and Ubuntu coverage
continues to use the six-way partition. Two full post-Stage-D runs show
Windows shard-job medians of **20.4–22.7m**, with about **21m** of divisible
test work and about **1.6m** of fixed overhead. Ten shards project an
approximately **8m** service-time benefit when all ten can run concurrently,
but at `max_entries_to_build=5` the theoretical Windows-cell request grows
from **30 to 50**. The account cap is unknown, so this is capacity risk rather
than a claim that Windows service time is insignificant.

**Expected benefit.** Preserve the current six-way partition and avoid moving
the projected eight-minute service reduction into an unmeasured runner queue
or an unknown account-capacity boundary.

**Preserved gates.** Required Ubuntu unit cells 1 through 4, the `unit-passed`
aggregate, the six-way coverage matrix and six-file loops, the exact host
check-name gate, `ALLGREEN`, and cross-contamination blocking remain required.
No Windows-ten workflow or ruleset change is included in this decision.

**Validation.** Recompute a bounded 20-run window with Windows test-step
median, P95 runner queue, merge-group wall time, failures, retries, and the
host-emitted check names. A staged A/B must retain six Ubuntu coverage shards
and compare the same required gates before changing the denominator.

**Rollback.** Revert this documentation/test/release decision as a unit if
the evidence is corrected. If the reopening gate is met, update the Windows
matrix, per-cell denominator, coverage owners, and this record together;
otherwise leave the workflow at six.

**Reopening gate.** Reopen a Windows-ten experiment when a 20-run window shows
median Windows test-step duration **>=18m AND P95 runner queue <=5m**, **or** a
staged A/B shows **>=5m P95 merge-group wall-time gain without >5m marginal
runner-queue growth**. This gate separates divisible Windows test work from
runner and end-to-end queue serialization.

## C9 post-land receipt contract

C9 receipts are individual structured records, not synthetic summary rows. The
identifier form is `stage-{d,a}-post-land-N`; `N` identifies one receipt in
the stage's closure set. The exact fields are:

```text
identifier=stage-{d,a}-post-land-N
actions=URL
run_duration_ms=<integer>
queue_wait_ms=integer|unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=ISO Z
timeline_merged_at=ISO Z
timeline_removed_at=ISO Z
unit_shards_executed=6
completed_at=ISO Z
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
```

For these receipts, `queue_wait_ms=unavailable` is honest: queue wait is a
per-job runner-wait measure, and no canonical run-level aggregation was defined
for these full-matrix receipts. Do not infer zero from the unavailable value.

Closure requires **3 receipts per stage**: three Stage-D receipts and three
Stage-A receipts. A stage is not closed by a partial set, a dashboard screenshot,
or a receipt that omits `queue_wait_ms` instead of using the literal
`unavailable` value.

For `eviction=none`, the receipt must show the initial timeline add followed by
the adjacent terminal `merged`/`removed_from_merge_queue` pair. The terminal
events may be timestamped in either order; `timeline_added_at`,
`timeline_merged_at`, and `timeline_removed_at` must all be retained, with no
intervening nonterminal removal/re-add. The Stage-D receipts below are full CI
matrix runs with all six Windows unit shards; matrix-skipped release runs and
the short PR-Standards sibling workflow do not qualify.

```text
identifier=stage-d-post-land-1
actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/34051617672
run_duration_ms=1841000
queue_wait_ms=unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=2026-09-06T18:24:18Z
timeline_merged_at=2026-09-06T18:55:43Z
timeline_removed_at=2026-09-06T18:55:43Z
unit_shards_executed=6
completed_at=2026-09-06T18:55:17Z
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
preserved_checks=unit-passed; recursive integration discovery; cross-contamination gate
```

```text
identifier=stage-d-post-land-2
actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/34060659584
run_duration_ms=1781000
queue_wait_ms=unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=2026-09-06T21:18:08Z
timeline_merged_at=2026-09-06T21:48:11Z
timeline_removed_at=2026-09-06T21:48:11Z
unit_shards_executed=6
completed_at=2026-09-06T21:48:07Z
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
preserved_checks=unit-passed; recursive integration discovery; cross-contamination gate
```

```text
identifier=stage-d-post-land-3
actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/34061223031
run_duration_ms=2435000
queue_wait_ms=unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=2026-09-06T21:29:16Z
timeline_merged_at=2026-09-06T22:10:31Z
timeline_removed_at=2026-09-06T22:10:30Z
unit_shards_executed=6
completed_at=2026-09-06T22:10:05Z
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
preserved_checks=unit-passed; recursive integration discovery; cross-contamination gate
```

### Stage-A post-land receipts

Three qualifying full-matrix runs below were created after PR #2624 merged at
`2026-09-07T06:07:23Z`. Each run completed successfully and its merge-queue
timeline shows the initial add followed by an adjacent terminal merge/remove
pair, with no intervening re-add. The receipts use `queue_wait_ms=unavailable`
because no canonical run-level runner-wait aggregation exists. The third, run
`34162959243`, was collected after the event-scoped cancellation change (PR
#2632) merged at `2026-09-07T16:39:21Z`, so the completed Stage-A set
includes a receipt post-dating every #2552 code change: receipts 1-2
post-date the Stage-A publication PR #2624, and receipt 3 also post-dates the
item-B cancellation PR #2632.

Run `34121635625` is explicitly excluded from the qualifying receipt set: its
release-please short-circuit skipped the CI matrix, so it is not a full-matrix
receipt despite its successful terminal timeline.

```text
identifier=stage-a-post-land-1
actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/34091796997
run_duration_ms=4351000
queue_wait_ms=unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=2026-09-07T06:38:55Z
timeline_merged_at=2026-09-07T07:52:10Z
timeline_removed_at=2026-09-07T07:52:10Z
unit_shards_executed=6
completed_at=2026-09-07T07:51:44Z
preserved_checks=unit-passed; recursive integration discovery; cross-contamination gate
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
```

```text
identifier=stage-a-post-land-2
actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/34092376492
run_duration_ms=4251000
queue_wait_ms=unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=2026-09-07T06:46:59Z
timeline_merged_at=2026-09-07T07:58:25Z
timeline_removed_at=2026-09-07T07:58:25Z
unit_shards_executed=6
completed_at=2026-09-07T07:57:59Z
preserved_checks=unit-passed; recursive integration discovery; cross-contamination gate
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
```

```text
identifier=stage-a-post-land-3
actions=https://github.com/ZaxbyHub/opencode-swarm/actions/runs/34162959243
run_duration_ms=2113000
queue_wait_ms=unavailable
eviction=none
eviction_evidence=timeline:add→terminal-merge/remove-pair
timeline_added_at=2026-09-07T21:23:12Z
timeline_merged_at=2026-09-07T21:59:07Z
timeline_removed_at=2026-09-07T21:59:07Z
unit_shards_executed=6
completed_at=2026-09-07T21:58:42Z
preserved_checks=unit-passed; recursive integration discovery; cross-contamination gate
terminal_pair_evidence=adjacent terminal merge/remove pair; no intervening re-add
```

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
- The retain-six Windows decision is landed for this evidence window; a future
  Windows-ten experiment remains gated and unlanded.
- The C9 contract requires three receipts per stage; all three Stage-D and
  all three Stage-A receipts are recorded as of 2026-09-07.

### Migration

No runtime or configuration migration is required. Stage D makes integration
discovery recursive and removes obsolete scanner notices; before applying any
future queue or branch-protection change, perform the host check-name gate and
collect the required C9 receipt closure set.

### Breaking changes

None. The documented timeout, concurrency, cancellation, and `ALLGREEN`
semantics are retained. Recursive integration discovery adds coverage without
changing those gates, and no Windows implementation is claimed here.
