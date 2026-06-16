# repo-graph: fix EPERM on incremental graph update (Windows)

## What changed

`saveGraph` in `src/tools/repo-graph/storage.ts` used an atomic temp-file + rename
pattern to write `repo-graph.json`. The rename retry loop only caught `EEXIST`
errors. On Windows, `rename()` over a file held open by another process (antivirus
on-access scanner, concurrent reader) returns `EPERM` rather than `EEXIST`, so
every incremental graph update failed immediately with:

```
ERROR: [repo-graph] Incremental update failed: EPERM: operation not permitted,
  rename '...repo-graph.json.tmp.<id>' -> '...repo-graph.json'
```

## Fix

- Retry condition expanded to `EEXIST | EPERM | EBUSY` — matching the pattern
  already used by `bun-compat.ts` and `worktree/core.ts` in this codebase.
- Retry loop refactored from a confusing `while`+inner-guard to the cleaner
  `bun-compat.ts`-style `for` loop (eliminates the off-by-one ambiguity in the
  constant name).
- Retry budget increased: 3 attempts (2 × 50 ms delays) → **5 attempts (4 × 100 ms
  delays, 400 ms total)**, covering typical AV on-access scan hold times for small
  JSON files.
- Added `_internals.fsRename` and `_internals.retryDelayMs` DI seams so the retry
  path can be exercised in unit tests without `mock.module` pollution. Tests set
  `retryDelayMs = 0` to skip real sleeps when exercising multi-retry paths.

## Migration

No migration required. The fix is transparent to callers.

## Caveats

- Persistent EPERM (real permissions error, not a transient lock) will still be
  surfaced after 5 attempts (~400 ms of delays).
- Orphaned `.tmp.*` files in `.swarm/` can occur if the AV scanner also holds the
  temp file during cleanup. Files are unique-named; they are not accumulated
  pathologically and are cleaned up by the next successful save.
