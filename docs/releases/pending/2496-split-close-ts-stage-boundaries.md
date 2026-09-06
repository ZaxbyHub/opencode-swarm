# Split close command stage boundaries (#2496)

## What changed

- Split the close command's finalize, archive, clean, align, dry-run, and orchestration stages into focused modules behind the existing `close.ts` facade.
- Moved shared close context, constants, filesystem helpers, database helpers, and the canonical test dependency seam into explicit owners.
- Added a structural guard that keeps the facade and stage modules bounded and prevents the implementation from reconsolidating into a hidden catch-all module.

## User-facing impact

There is no command, output, configuration, persistence, or migration change. Existing close ordering, locking, failure propagation, partial-archive behavior, and SQLite snapshot/WAL handling are preserved.
