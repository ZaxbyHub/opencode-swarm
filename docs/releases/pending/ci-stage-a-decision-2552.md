# Stage-A Windows shard decision

## What changed

- Documented the evidence-backed decision to retain six Windows unit shards for
  the current merge-queue window.
- Added the measured 56-run window, the Windows service-time and queue metrics,
  numeric reopening gates, and three timeline-backed Stage-D receipts.
- Added a structural CI policy test that keeps the six-way workflow, runtime
  denominator, coverage loops, and `unit-passed` aggregate aligned.

## Why

Windows ten-way sharding projects an approximately eight-minute service-time
benefit, but it would increase theoretical Windows cells from 30 to 50 at
`max_entries_to_build=5` while account capacity remains unknown. Retaining six
shards preserves required gates until a bounded experiment can attribute a net
wall-time benefit separately from runner queue and merge-group serialization.

## Migration

No workflow or configuration migration is required. A future Windows-ten
experiment must satisfy the documented 20-run reopening gate and update the
matrix, denominator, coverage owners, policy test, and decision record together.

## Breaking changes

None. Ubuntu and macOS remain six-way, Windows remains six-way, and the
required `unit-passed` and coverage gates are unchanged.

## Caveats

Two qualifying Stage-A post-land full-matrix receipts are recorded in the
policy decision record; a third remains pending. Run `34121635625` is excluded
because its release-please short-circuit skipped the CI matrix. The account
concurrency cap is unavailable, and the record does not treat that unknown as
zero.
