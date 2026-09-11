# PR-workflow gate retention authority registration (#2510)

## What changed

- Registered the PR-workflow gate as one logical durable stream with
  `swarm.db` `coordination_state[pr-workflow.state:<session-stem>, state]` as its
  authority key; the session stem is the sanitized slug-plus-digest form of the
  original session ID, and the `.swarm/pr-workflow-gates/` files are bounded
  projections.
- Documented the writer, reader, recovery, lock/CAS, crash-replay, terminal
  cleanup, and bounded audit-event contracts in the retention registry.
- Added an end-to-end regression covering aged projection repair, crash-shaped
  replay, terminal cleanup, and non-resurrection after retention.

## Why

The registry previously described only the JSON shadow and called it
authoritative, leaving the SQLite authority and recovery contract implicit.
This change makes the metadata truthful and keeps future retention changes from
mistaking the projection or audit trail for gate-state authority.

No migration or runtime lifecycle change is required.

Closes: #2510
