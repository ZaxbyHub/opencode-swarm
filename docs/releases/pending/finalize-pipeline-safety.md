## Summary

Phase 4 finalize pipeline safety hardening introduces four user-visible improvements:

1. **Concurrent finalize lock (FR-012)** — Two simultaneous `/swarm finalize` runs on the same project now reject the second invocation with an explicit error. If a finalize run is interrupted or the lock expires, a subsequent run retries cleanly.
2. **Git alignment preserves user untracked files (FR-013)** — The `git clean -fdX` step in the Align stage now removes only gitignored build artifacts. User-created untracked files are preserved. Updated help text reflects this.
3. **Transactional plan-state persistence (FR-014)** — If terminal plan-state persistence fails, the close summary no longer falsely claims phases and tasks were closed. The rollback is now atomic.
4. **Configurable evidence retention (FR-016)** — Archive retention is now configurable via `evidence.max_age_days` and `evidence.max_bundles` in your project config. Defaults for `/swarm finalize` are 30 days / 10 bundles; `/swarm archive` retains its 90 days / 1000 bundles defaults.

## Why

1. **Concurrent finalize** — Without locking, two simultaneous finalize runs could corrupt plan state or produce duplicate archives. The lock serializes concurrent calls and returns an explicit error for the second.
2. **Git alignment** — `git clean -fd` removes ALL untracked files including user work. Using `-fdX` targets only gitignored build artifacts (`node_modules/`, `.gitignore`-listed outputs), preventing accidental deletion of user-created files.
3. **Transactional persistence** — The close summary was reporting successful phase/task closure even when the underlying ledger write had failed. Now the summary reflects actual state.
4. **Retention config** — Projects with limited storage needed a way to reduce finalize's archive footprint. The 30/10 defaults for finalize are tighter than archive's 90/1000 because finalize runs at project end while archive is a periodic maintenance command.

## Migration

No migration required. The new behavior is opt-in via config or transparent (concurrent lock, transactional rollback).

To change finalize retention, add to your project config:

```json
{
  "evidence": {
    "max_age_days": 14,
    "max_bundles": 5
  }
}
```

## Breaking changes

None.

## Internal changes

- **FR-015 (retro-lesson dedup)** — Lessons already present in the knowledge store are skipped during close-time curation, preventing duplicate entries from being reinforced.
