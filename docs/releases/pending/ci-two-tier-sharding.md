# CI: Two-tier CI with automatic test sharding

## What changed

The CI pipeline (`ci.yml`) was restructured to reduce PR feedback time from ~40 minutes to ~12 minutes and to prepare for merge queue adoption.

**Two-tier CI:** Merge-queue-only jobs (`integration`, `smoke`, `php-validation`, `rust-sandbox-runner`) now gate all their steps with `if: github.event_name == 'merge_group'`. On `pull_request`, those jobs run but all steps are skipped, so the job completes in ~10 seconds while still satisfying required status checks. On `merge_group`, the full validation runs. Jobs that were always fast (`quality`, `package-check`, `security`) continue running on both events unchanged.

**Automatic round-robin test sharding:** The 20 hand-maintained test steps (which duplicated ~111 files and silently skipped ~177 files) have been replaced with automatic file discovery via `find tests/unit -name '*.test.ts' -type f | sort` distributed across 4 parallel shards using modulo assignment. All test files are covered with zero duplication.

**Dynamic OS matrix:** Unit tests run on ubuntu-only for PRs and the full 3-OS matrix for merge queue runs.

## Why

1. **Cascading CI restarts:** When one PR merges, branch updates cascade to all open PRs, each restarting a 40+ min CI run. Enabling the merge queue (see below) stops the cascades entirely.
2. **CI duration:** The critical path through quality → unit (3-OS matrix, 140+ sequential files) → integration → smoke was 40+ minutes. Sharding and the two-tier split bring PR feedback to ~12 minutes.

## Migration steps (admin required)

The `unit` job matrix gains a `shard` dimension, changing required check names:

- **Old:** `unit (ubuntu-latest)`, `unit (macos-latest)`, `unit (windows-latest)`
- **New:** `unit (ubuntu-latest, 1)` through `unit (ubuntu-latest, 4)` (PR tier); `unit (ubuntu-latest, 1)` through `unit (windows-latest, 4)` (merge queue tier)

**Branch protection migration** (atomic path preferred — add new checks before removing old to avoid a protection gap):
1. Add new required checks: `unit (ubuntu-latest, 1)` through `unit (ubuntu-latest, 4)`, plus `quality`, `package-check`, `security`
2. Merge this PR
3. Remove old `unit (...)` required checks
4. The merge-queue-only jobs keep their existing names

**To eliminate cascading CI restarts (Problem #1), also:**
- Enable the GitHub merge queue on `main` in branch protection settings
- Disable "Require branches to be up to date before merging" (the merge queue handles freshness validation)

**Release-please fast-track:** A `detect-release` job (~5s) identifies release-please branches for both PR and merge-queue events. When detected, all downstream jobs (quality, unit, integration, security, package-check, php-validation, rust-sandbox-runner, smoke) skip their steps and report success immediately. This avoids 15+ minutes of pointless testing on auto-generated version bumps. Detection uses `github.head_ref` for PR events and commit-message matching (`chore(main): release`) for merge-group events where `github.head_ref` is unavailable.

## Known caveats

- PR runs no longer run integration, smoke, php-validation, or rust-sandbox-runner. Cross-platform and integration bugs are caught at merge queue time instead of during development.
- macOS and Windows unit test failures are only surfaced in the merge queue, not on individual PRs.
- `repro-704` (plugin init deadline verification, AGENTS.md invariant 1) runs in the `smoke` job and is deferred to merge queue only.
- Unit job timeout reduced from 90m (pre-sharding, PR #1245) to 40m per shard. Windows merge-queue shards are estimated at 20-25 min; monitor first runs and adjust if needed.
