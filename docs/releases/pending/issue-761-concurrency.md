Users can now adjust task execution concurrency during an active plan without modifying or unlocking the locked plan execution_profile.

Added `/swarm concurrency` CLI command with three subcommands:
- `set <N>` — override max_concurrent_tasks to N (1-64)
- `set <preset>` — presets: min (1), medium (3), max (8)
- `status` — display effective concurrency (override, plan baseline, operational effective)
- `reset` — clear override, revert to plan value

The override is session-scoped, persisted via session snapshots across plugin reloads, and cleared on session reset. It does not modify `.swarm/plan.json` or the plan ledger.

No migration required.
