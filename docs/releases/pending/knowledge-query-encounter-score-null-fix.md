# Knowledge query crash on hive tier (issue #914)

## What changed

### Fix `knowledge_query` crash when hive entries lack `encounter_score` (issue #914)

Two defensive changes close the crash:

1. **`normalizeEntry()` backfill (`src/hooks/knowledge-store.ts`)** — Legacy hive
   entries written before the `encounter_score` field existed may not contain it.
   `normalizeEntry()` now backfills `encounter_score = 0` when the field is
   missing, `undefined`, `null`, or `NaN`. This ensures all in-memory entries
   have a valid number for the field per spec FR-002.

2. **`formatHiveEntry()` optional chaining (`src/tools/knowledge-query.ts`)** —
   Defense-in-depth: `entry.encounter_score?.toFixed(2) ?? 'N/A'` prevents a
   crash even if an entry reaches `formatHiveEntry()` without going through
   `normalizeEntry()`.

## Why

Hive entries promoted before `encounter_score` was added to the schema lack the
field entirely. When `knowledge_query` with `tier: 'hive'` or `tier: 'all'`
formatted those entries via `formatHiveEntry()`, calling `.toFixed(2)` on
`undefined` threw `TypeError: Cannot read properties of undefined (reading
'toFixed')`, crashing the tool and surfacing a non-user-actionable error.

The root cause is a schema evolution gap: older entries were not migrated on
read. The fix applies the default at normalization time (read path) and adds a
runtime guard at the formatting boundary.

## Migration steps

None. No configuration changes are required. Existing hive entries are
automatically normalized on next read.

## Known caveats

- The `normalizeEntry()` backfill sets `encounter_score = 0` for legacy entries.
  This is the spec-defined default per FR-002 and does not affect promotion
  logic (which derives encounter scores from retrieval events, not from this
  field directly).
- No on-disk schema migration is performed. The backfill is in-memory only.
- Three new test files cover the null-safety behavior.
