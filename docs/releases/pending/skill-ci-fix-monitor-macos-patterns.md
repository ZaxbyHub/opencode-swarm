# docs: add macOS cross-platform file I/O fixes to ci-fix-monitor skill

## What changed

Added macOS cross-platform file I/O failure patterns to the
`ci-fix-monitor` skill (and its Codex adapter):

1. New row in the failure classification table for "macOS unit test"
   (cross-platform file I/O race)
2. New section "macOS file I/O fixes (cross-platform atomic write)"
   documenting the three-layer fix pattern:
   - Use `bunWrite` from `src/utils/bun-compat.ts` for atomic writes
   - Add ENOENT retry in the read path (5 attempts, 10ms delay)
   - Node FileHandle uses `.sync()`, not `.fsync()`
3. Note about the related security test pattern (path length guard
   before `validateSwarmPath`)

## Why

These patterns were discovered while fixing pre-existing CI failures
on PR #1363. macOS/APFS has different filesystem timing than Linux
ext4 — `fs.renameSync` can complete before the data is visible to
subsequent reads, causing `unit (macos-latest)` to fail on tests that
write-then-read atomic files.

## Migration

No migration required. Skill changes are internal documentation.

## Known caveats

- The `bunWrite` reference assumes the function exists in
  `src/utils/bun-compat.ts` — if renamed or moved, the skill should
  be updated.
- The 5-attempt / 10ms retry values are defaults; tune based on
  observed macOS filesystem behavior.
