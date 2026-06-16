# Knowledge counter baseline and rollup correctness (PR #1335 feedback)

## What changed

- **Counter baseline and rollup implementation aligned with origin/main.** The counter baseline/rollup implementation in `src/hooks/knowledge-events.ts` was aligned with origin/main after resolving merge conflicts.

- **`learning-metrics.ts` reads persisted counter baseline.** `readKnowledgeCounterRollups(directory)` is now used so that metrics include evicted-event counters preserved in the baseline, anchoring session-level retrieval outcomes to durable state.

- **`searchKnowledge` forceReadHive fix preserved.** Manual recall with `forceReadHive: true` continues to correctly surface hive entries even when `config.hive_enabled` is false.

- **Windows test isolation hardened.** `learning-loop-e2e.test.ts` preserves LOCALAPPDATA/XDG_DATA_HOME save/restore logic to prevent cross-test pollution on Windows.

- **learning-metrics.test.ts updated to flat baseline format.** Unit tests for `learning-metrics.ts` were updated to match origin/main's flat baseline format.

- **knowledge-durability.test.ts removed.** The test file was removed because it depended on PR-specific API names and behaviors that no longer match origin/main.
