---
category: Fixed
---

# Atomic cross-process coordination

- Replaced last-writer-wins coordination files with FULL-durability SQLite transactions for session snapshots, background ownership and PR subscriptions, scope generations, PR-review authorization and workflow gates, and Lean/Epic lane state.
- Added revision and generation fences, idempotent event application, process leases, strict one-time legacy imports, and post-commit compatibility projections.
- Added `/swarm status` visibility for uncertain initialization and rejected background work, plus `/swarm recover --coordination` for an explicit safe retry.

Migration is automatic on first use. Existing authority files are validated, imported exactly once, and renamed with an `.imported` suffix; generated projection files remain for one release. Corrupt or ambiguous legacy state fails closed and must be repaired before retrying recovery.

No configuration changes or breaking API changes are required. A very large number of distinct event streams can temporarily keep the global event count above its soft 100,000-row target because the current waterline for every stream is retained for safe replay.
