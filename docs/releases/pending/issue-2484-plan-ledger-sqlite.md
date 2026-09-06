# SQLite-backed plan ledger migration contract

Issue #2484 (Workstream D5) defines the additive SQLite plan-ledger path:

- Adds plan-ledger event, state, and import tables to `.swarm/swarm.db`;
  existing durable-state tables are unchanged.
- Preserves each existing `JSON.stringify(event)` representation as an exact
  UTF-8 BLOB (without its JSONL newline), rejects malformed UTF-8 during durable
  reads, and continues to allow valid U+FFFD plan content.
- Uses a staged rollout: one release of JSONL authority plus SQLite
  `file_shadow`, structured independent parity, then a per-project,
  version-gated SQLite cutover. Legacy projects are not switched immediately.
- Imports legacy JSONL only into an empty namespace after first preserving a
  content-addressed archive, retains the active file through shadow mode, and
  keeps crash recovery idempotent. After cutover, JSONL is a portable
  derived export rather than a second authority.
- Restricts crash and rollback repair to the last mutually verified prefix;
  divergent committed prefixes fail closed. Reset, rollback, close, and the
  six plan projections retain explicit recovery/archival boundaries.

This fragment records the migration contract; it does not claim that the
shadow release or cutover has already elapsed.
