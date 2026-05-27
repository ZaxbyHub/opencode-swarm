# Memory Maintenance Observability

- Adds `/swarm memory pending`, `/swarm memory recall-log`, `/swarm memory stale`, and dry-run-by-default `/swarm memory compact` commands for long-running memory stores.
- Expired scratch memory remains hidden from default recall/list paths; compacting deleted, superseded, and expired scratch records requires explicit `--confirm`.
- Recall usage can now be summarized by agent role and memory ID, with most-recalled, never-recalled, low-utility, and rejected-proposal diagnostics.
