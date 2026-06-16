## Fixed

- Closed a TOCTOU window in `bumpCountersBatch` (used by `recordAcknowledgment`)
  and in the `knowledge_archive` tool. Both paths previously did an unlocked
  `readKnowledge` followed by a locked `rewriteKnowledge`, allowing a concurrent
  `appendKnowledge` (or any other writer) to have its update silently dropped
  by the rewrite. The hive file is shared across concurrent sessions of
  different projects via the global XDG path, so this was the worst-case shared
  state.

  Both call sites now route through `transactKnowledge`, the same
  locked read-modify-write pattern used by `knowledge_remove`, the escalator,
  the curator, and the sweep functions. For `bumpCountersBatch` a separate
  transaction is run for the swarm file and the hive file (only when the hive
  file exists); the `mutate` callback returns `null` when no entry was touched,
  preserving the existing no-rewrite short-circuit. Two regression tests
  exercise the concurrent-bump and forced-delay-under-lock paths.

**Why:** TOCTOU between unlocked read and locked rewrite could silently lose
concurrent writes to the shared knowledge file, with no error visible to the
caller.

**What this gives you:**
- Concurrent `recordAcknowledgment` calls no longer drop entries appended
  in between the read and the rewrite.
- The audit tombstone and `purge` / `quarantine` / `archive` behavior of
  `knowledge_archive` is unchanged; only the read+rewrite boundary moved
  inside the lock.

**Migration:** none. The public tool surface, response shape, and on-disk
file format are unchanged.

**Notes / caveats:**
- The fix relies on the existing `transactKnowledge` helper
  (`src/hooks/knowledge-store.ts`), which acquires a `proper-lockfile` lock
  on the parent directory for the duration of the read and rewrite.
- `bumpCountersBatch` now holds the lock for the duration of one file's
  read+modify+write rather than releasing it between the read and the write.
  Under typical contention this is microseconds, but callers should be aware
  that the critical section is no longer unlockable from another process.
