# Memory System Phase 2: Performance & Scaling

## What changed

- **Provider singleton pool (DD-04):** Memory providers are now reused across gateway constructions via a process-level LRU pool (max 16 entries, keyed by canonical directory). Eliminates per-call full-table reload. Includes refcount tracking, deferred-close-on-eviction, and deferred-entry re-promotion.
- **SQL-side scope/kind filtering (DD-04):** `list()` now filters at the SQL layer using `WHERE scope_key IN (...)` with canonical `stableScopeKey()` and optional `LIMIT` pushdown, instead of loading all rows into memory and filtering in JavaScript.
- **Recall write deduplication (DD-08):** Removed redundant `event('recall')` write — `recordRecallUsage` now writes only to `memory_recall_usage`.
- **Timestamp index (DD-09):** Added migration v5 `idx_memory_recall_usage_timestamp` for `ORDER BY timestamp DESC` queries.
- **File/symbol scoring signals (DD-10c):** `gateway.propose` now extracts file paths and symbols from evidenceRefs, populating `metadata.files`/`metadata.symbols` so `fileOverlap`/`symbolOverlap` scoring signals fire.
- **Distinct userGoal/agentTask (DD-10a):** `agentTask` is now extracted from the most recent Task tool_use block in messages (supports both standard and MessageWithParts shapes), falling back to latestUserText.
- **Dead code removal (DD-10b):** Deleted unreachable `buildScopesFromInput` from recall-planner.ts.
- **Auto-compaction (DD-18):** Fire-and-forget compaction triggers after every N recalls (configurable via `memory.maintenance.autoCompactEveryNRecalls`, default 50, 0 disables) with `compact_triggered` event logging.

## Why

The memory system reloaded every row from SQLite on every chat turn, wrote redundant audit rows on recall, had no automated compaction, and left 20% of recall scoring weight on dormant signals. These changes address all five performance and scaling findings from the deep-dive audit.

## Migration

No migration required for users. Existing databases are automatically backfilled: scope_key values are updated to canonical `stableScopeKey()` form on first initialization (one-time, guarded by `_meta` table marker).

## Breaking changes

None. All changes are additive or internal. The `list()` method signature is backward compatible (optional `limit` parameter added). The `close()` behavior on pooled providers is transparent to callers via the one-shot `MemoryGateway.dispose()` pattern.

## Known caveats

- Migration version 4 (`_meta` table) and version 5 (`idx_memory_recall_usage_timestamp`) are new. Version 4 was needed for the scope-key backfill guard.
- `refCount` is per-provider, not per-acquisition. Callers must use `MemoryGateway` (or equivalent one-shot wrapper) to prevent double-release. Documented in JSDoc on `releaseProvider()`.
