# `ci(release)`: cover the dispatched ci.yml run's 40-minute ceiling in the cleanup wait budget

## What changed

- `.github/workflows/release-and-publish.yml` — the `cleanup-release-fragments` job's wait for the dispatched `ci.yml` run now polls `wait_for_dispatched_run ci.yml 480 5` (2,400 s = 40 min) under `# target-duration: 40`, up from `360 5` (30 min) under `# target-duration: 30`. The 40-min budget matches the dispatched `ci.yml` `unit` matrix job's own declared `timeout-minutes: 40` per-shard ceiling, instead of sitting 10 min below it.
- The coupled job-level `timeout-minutes` rose from 70 to 80: the three declared waits now sum to 40 + 10 + 10 = 60 min (3,600 s), so `scripts/check-workflow-timeouts.ts` requires `ceil(3,600 × 1.2) + 5 min` = 4,620 s = 77 min; 80 keeps 3 min of slack. The arithmetic comment above the value was re-derived to match.
- `wait_for_dispatched_run` now rejects non-numeric `max_attempts` / `poll_seconds` arguments up front (PRR-012 from the #3242 review): previously a bad budget made `seq` fail inside the `for` list, the poll loop was skipped entirely, and the helper reported a false `Timed out` without ever polling. The guard turns that into a precise `::error::` naming the bad argument.
- New regression suite `tests/unit/scripts/check-workflow-timeouts-issue-3259.test.ts`: fixture copies prove the lint reds on the raised budget under a stale 70-min timeout (`required 4620s`) and on a 30-min budget under a 40-min target; live-file ratchets pin the new call site, the sibling waits (pr-standards/drift-check at `120 5`, target 10), the untouched `release-health-summary` job, and the cross-file ceiling coupling (budget minutes ≥ `ci.yml` `unit` `timeout-minutes`); a bash probe executes the shipped helper and asserts a non-numeric budget exits 1 with the guard message and no false `Timed out`.

## Why

Issue #3259 (#2952 residual, PRR-005 from the #3242 review): the wait budget (30 min) equaled its self-certified target but sat below the dispatched workflow's real ceiling (40 min per shard). A healthy-but-slow dispatched `ci.yml` run would exhaust the wait, `wait_for_dispatched_run` would return 1, the step would abort under `set -euo pipefail`, `cleanup-release-fragments` would fail, and the already-created cleanup PR would strand — the exact #2952 failure mode at a higher threshold (observed dispatched duration 16m05s, ~1.9× headroom today). The shipped lint could not catch it because the directive self-certifies within one file and never reads `ci.yml`'s ceilings; raising the budget to the ceiling and letting the lint enforce the coupled arithmetic closes the gap without the (separately owned, #3243) lint hardening.

## Migration steps

None. The change is confined to the release workflow's wait arithmetic and its tests; no configuration, tool, or runtime surface is affected.

## Known caveats

- The `quality` leg of the dispatched `ci.yml` run declares no `timeout-minutes` and inherits GitHub's 360-minute default, so the 40-min budget does not bound that leg's theoretical worst case. This is the documented residual from the issue: mitigated by the observed 16m05s duration and the fact that a queued-not-started run is not matched by the `createdAt >= dispatch_after` poll until it starts. Closing it fully would need a `quality` job ceiling (ci.yml job definitions are explicitly out of #3259 scope).
- AC4 (demonstration on the next live release: cleanup `success`, health summary green) is a post-merge observation, same protocol as #2952 AC7; it cannot be executed from this PR.
