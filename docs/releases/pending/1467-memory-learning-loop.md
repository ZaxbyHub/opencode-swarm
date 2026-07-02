## What changed

Round 1 of issue #1467 ships memory recall learning from council verdicts:

### Auto-promotion from council verdicts

Council and phase-council submissions now update the Q-value of memories recalled for the same run, using an exponential moving average over `APPROVE`, `REJECT`, and `CONCERNS` outcomes. Recall scoring boosts high-Q memories and suppresses low-Q memories by default.

### `runId` fallback for cross-session recall

When a memory is recalled in a session where it was never actually recalled (i.e., no `memory_recall_usage` row for that `runId`), the system falls back to the most recent `runId` that did recall it. This enables cross-session Q-value propagation — a memory boosted by council verdict in session A is immediately more likely to be recalled in session B.

### Atomicity via `db.transaction`

All Q-value update operations (including FTS shadow-index maintenance) are wrapped in `db.transaction()` to ensure atomicity. If any step fails, the entire update rolls back.

### `/swarm memory value-log` command

New `swarm_memory_value_log` tool and `/swarm memory value-log` CLI command show recent Q-values, reward outcomes, suppression candidates, and promotion candidates for the current session.

## Deferred in this phase

The following items were scoped out of Round 1 and are targeted for follow-up:

- **F-004 — Embedding cosine propagation gate:** The implementation uses token-overlap similarity only. Embedding cosine similarity propagation is a follow-up enhancement that would enable semantically similar memories to receive a fraction of Q-value updates even when they were not directly recalled.

- **F-005 — `listMemoryValueLog` O(N) iteration:** Currently iterates over the in-memory `memories` Map before applying `LIMIT`. Acceptable for typical swarm session sizes (10–100 memories); CLI-only path. SQL-level pushdown (filter+limit at the SQLite layer) is deferred to a follow-up.

- **F-006 — `writeMemory` per-update SQL statement count:** Current implementation performs `INSERT OR REPLACE` + FTS `DELETE` + FTS `INSERT` per Q-value update. The FTS rebuild is wasted work when only the q-value changed. A targeted `UPDATE` path that avoids FTS churn is deferred to a follow-up.

## Migration version note

The schema migration for this feature is `add_recall_learning_columns` at **version 7** — not v5 as issue #1467 originally specified:

- **v2** is reserved by `LEGACY_JSONL_MIGRATION_VERSION` (`src/memory/jsonl-migration.ts:9`)
- **v5** was occupied by the `create_recall_usage_timestamp_index` migration
- **v6** was occupied by the `create_embedding_config_table` migration
- **v7** is the first available slot for this change
