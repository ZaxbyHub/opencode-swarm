# Legacy hive data migration

One-time, idempotent migration for users who ran `/swarm promote` before v7.63.0 and have entries stranded in the legacy `{platform-data-dir}/hive-knowledge.jsonl` file (written by the now-removed duplicate `src/knowledge/hive-promoter.ts`). The new canonical knowledge system writes to `{platform-data-dir}/shared-learnings.jsonl` only, so legacy entries are invisible to `knowledge_query` and `readMergedKnowledge` until migrated.

`migrateHiveKnowledgeLegacy()` (added to `src/hooks/knowledge-migrator.ts`) reads the legacy file, converts each entry to the modern `HiveKnowledgeEntry` schema with sensible defaults (`tier: 'hive'`, `status: 'established'`, `encounter_score: 1.0`, `migration:legacy-hive` tag, `source_project: 'legacy-promotion'`), deduplicates against existing canonical entries using the configured 0.6 Jaccard threshold, and writes a `.hive-knowledge-migrated` sentinel under the platform data directory to prevent re-running. The function validates each entry via `validateLesson`, defends against duplicate legacy IDs (regenerates UUID on collision), and now recovers per-entry failures instead of crashing the whole migration.

Integrated into `handleKnowledgeMigrateCommand()` in `src/commands/knowledge.ts`, so `/swarm knowledge migrate` runs both migrations (context.md → knowledge.jsonl AND legacy hive → shared-learnings.jsonl) with a single invocation and reports the consolidated result.

## User-visible changes

- `/swarm knowledge migrate` now also recovers entries from the legacy `hive-knowledge.jsonl` file. No new command, no new flag, no new config option.
- Per-entry failures during migration (disk full, permission error, validation failure) are logged and the affected entry is dropped rather than crashing the migration. The returned `MigrationResult` includes an `entryErrors` array summarising per-entry failures when present.

## Tests

17 unit tests in `tests/unit/hooks/knowledge-migrator-legacy.test.ts` cover the sentinel gate, no-legacy-file gate, empty-file gate, single and multi-entry migration, short-lesson dropping, missing-lesson dropping, default and explicit category/confidence/scope/id, ID collision UUID regeneration, dedup against existing canonical entries, `confidence: 0` preservation, and per-entry error continuation on `appendKnowledge` failure.

The 8 integration tests in `tests/integration/promote-knowledge-query-visibility.test.ts` verify that manual `/swarm promote` output is visible to `knowledge_query` end-to-end (canonical-store round-trip, not just CLI text). These guard the underlying v7.63.0 promote→query integration that the migration now relies on.
