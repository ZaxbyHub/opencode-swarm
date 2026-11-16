# CI: Correct Stale Unit Shard Sizing Comment

## What

The comment above `timeout-minutes` on the `unit` job in `.github/workflows/ci.yml`
described ~278 test files per shard and 20-25 min Windows shards. It now reflects
the measured state (2026-10-18): ~685 gated files per shard (4,118 files on Linux
and 4,112 on Windows after quarantines, over 6 shards) and Windows unit cells of
~19-37 min (median ~29 min, test step median ~1650 s; 84 executed cells across
14 merge_group runs incl. 4 that failed on test results) against the 40-minute
timeout, leaving as little as ~3 min of headroom.

## Why

The stale numbers hid how little timeout headroom the Windows unit cells have.

## Migration / breaking changes

None. Comment-only change: no workflow value, trigger, matrix, or timeout is
modified. The recorded `.github/workflows/ci.yml` hash in
`docs/ci/required-check-evidence.json` is refreshed to match.

## Caveats

None.
