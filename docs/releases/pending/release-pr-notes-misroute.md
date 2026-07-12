# release-and-publish: fix update-pr-notes misroute when a release is cut and a new PR opens in one run

## What changed
`update-pr-notes` in `.github/workflows/release-and-publish.yml` was gated on `if: releases_created != 'true'`. That condition is wrong when release-please both cuts the prior release (e.g. v7.114.0) AND opens/updates the next pending release PR (e.g. #1815 for v7.114.1) in the same workflow run — `releases_created` is `true` for the cut, so the PR-body aggregation job is skipped entirely, leaving the new release PR without its `<!-- custom-release-notes:start -->` block (no rich notes). The fix makes `update-pr-notes` run unconditionally (`if: always()`); `modeUpdatePr` already no-ops gracefully when no `autorelease: pending` PR exists.

## Why
PR #1812 (the skills truth-sweep) merged shortly after PR #1810 (the prior release) on the same day. When #1812 hit main, release-please cut v7.114.0 (from #1810's merge) and opened #1815 for v7.114.1. Because `releases_created == 'true'`, `update-pr-notes` was skipped and #1815 shipped with bare commit-list notes instead of the rich `skills-audit-truth-sweep.md` fragment. The same misroute recurs whenever two release cycles overlap in one run.

## Migration
None.

## Breaking changes
None. `update-pr-notes` now always runs; when there is no pending release PR it exits 0 (no-op), as it already did.

## Caveats
`update-release-notes` (the GitHub-Release-body aggregator) is unchanged — it still only runs when `releases_created == 'true'` (a tag was cut). The two jobs are independent: one keeps the GitHub Release body in sync after a tag; the other keeps the open release PR body in sync. Both can legitimately run in the same workflow run.
