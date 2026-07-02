## What changed

Issue #1467 ships memory recall learning from council verdicts:

### Reward from council verdicts

Council and phase-council submissions update the Q-value of memories recalled for the reviewed task, using an exponential moving average over `APPROVE`, `REJECT`, and `CONCERNS` outcomes. Recall scoring boosts high-Q memories and suppresses low-Q memories by default. Auto-promotion moves session memories whose Q-value and recall count cross configured thresholds to durable storage.

### Reward targeting: validated multi-session matching, not an unscoped fallback

The reward is applied to every recall bundle whose session id is confirmed to belong to the current review: the submitting session's own id (trusted, host-derived), plus — when supplied — each dispatched council member's own `sessionId` reported on their verdict and an optional `provenanceSessionId`. Caller-supplied ids are validated against the real, currently-tracked session registry before being trusted; an unrecognized or spoofed id is dropped rather than matched. A submission with no matching recall bundle returns `no_recall_usage_for_run` — there is no "grab whatever was recalled recently" fallback, since that could reward an unrelated task's recall bundle. Repeated submissions for the same swarm/task/round are idempotent.

Known limitation: matching is still per-session, not per-task/round — a session that recalls memory across more than one task/round only has its single most recent bundle considered unless distinct member session ids are reported per verdict.

### Atomicity via `db.transaction`

All Q-value update operations (including FTS shadow-index maintenance) are wrapped in `db.transaction()` to ensure atomicity. If any step fails, the entire update rolls back.

### Bounded soft propagation: token overlap OR embedding cosine similarity

Propagation to recently-recalled, same-scope memories qualifies via either lexical token overlap (same `kind` required) or, when `embeddings.enabled` and a provider is available, embedding cosine similarity (not restricted to the same `kind`, since embeddings capture cross-kind semantic relationships). Embeddings are disabled by default, in which case propagation is lexical-only with no added cost. Both paths are capped by `memory.learning.propagationFanout` and `memory.learning.propagationLookbackDays`.

### `/swarm memory value-log` command

New `swarm_memory_value_log` tool and `/swarm memory value-log` CLI command show recent Q-values, reward outcomes, suppression candidates, and promotion candidates. `/swarm memory stale` now also lists low-Q suppression candidates, and `/swarm memory pending` now also lists promotion candidates.

### New `memory.learning` config block

`learningRate`, `propagationFactor`, `qValueBoostWeight`, `suppressionThreshold`, `promotionThreshold`, `propagationTokenOverlapThreshold`, `propagationEmbeddingCosineThreshold`, `propagationFanout`, and `propagationLookbackDays` are all configurable under `memory.learning` — see `docs/memory.md` for defaults and an example.

## Deferred in this phase

- **`listMemoryValueLog` O(N) iteration:** iterates over the in-memory `memories` Map before applying filters/limit. Acceptable for typical swarm session sizes (10–100 memories); CLI-only path. SQL-level pushdown (filter+limit at the SQLite layer) is deferred to a follow-up.

- **`writeMemory` per-update SQL statement count:** performs `INSERT OR REPLACE` + FTS `DELETE` + FTS `INSERT` per Q-value update. The FTS rebuild is wasted work when only the Q-value changed. A targeted `UPDATE` path that avoids FTS churn is deferred to a follow-up.

- **Per-task/round reward scoping:** rewarding a session's exact recall bundle for the specific task/round under review (rather than that session's single most recent bundle) would require threading a task/round identifier through the recall-time call chain, which does not currently exist. Reporting each council member's own session id on their verdict (supported now) is the interim mitigation.

## Migration version note

The schema migration for this feature is `add_recall_learning_columns` at **version 7** — not v5 as issue #1467 originally specified:

- **v2** is reserved by `LEGACY_JSONL_MIGRATION_VERSION` (`src/memory/jsonl-migration.ts:9`)
- **v5** was occupied by the `create_recall_usage_timestamp_index` migration
- **v6** was occupied by the `create_embedding_config_table` migration
- **v7** is the first available slot for this change

A follow-up migration (**version 8**, `add_recall_reward_idempotency_key`) adds a `reward_key` column used to make repeated council-verdict submissions for the same round idempotent. Both migrations tolerate a "duplicate column name" error from a losing concurrent-process race (no cross-process migration lock exists) rather than crashing `initialize()`.
