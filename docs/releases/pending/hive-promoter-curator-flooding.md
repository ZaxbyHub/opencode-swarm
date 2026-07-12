# Bound curator promotion recommendations

## What changed

- Hive promotion checks no longer write curator recommendations when no hive state changed.
- Curator recommendations are semantically deduplicated, capped at 200 entries, and updated through a shared locked persistence path.
- Existing bloated `curator-summary.json` files are cleaned automatically on first read.
- Knowledge curation now ingests lesson-bearing entries throughout an evidence bundle instead of inspecting only the first entry, with project-scoped idempotency.

## Why

Repeated all-zero hive observations could grow curator summaries to thousands of duplicate entries and inject that noise into every curator briefing. Later retrospective entries in evidence bundles could also be missed.

## Migration

No manual migration is required. Existing summaries are normalized automatically when reopened.

## Breaking changes

None.

## Known caveats

None.
