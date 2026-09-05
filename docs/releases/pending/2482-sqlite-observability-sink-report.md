# SQLite observability sink and /swarm report (issue #2482)

Adds the canonical event envelope's durable local query authority in `.swarm/swarm.db`
(Workstream D PR 3) plus the `/swarm report` command.

- **SQLite observability sink**: new `observability_event` / `observability_sink_health` /
  `observability_import` tables (migrations v29–v32; durability class `normal`). The sink
  registers as a telemetry listener (the canonical envelope rides a new optional third
  listener parameter), batches writes through the existing group-commit writer, enforces a
  50,000-row DELETE-oldest retention cap and a 16 KiB per-payload cap, quarantines malformed
  events in-table with a reason instead of dropping them, and persists its own health
  counters. Fail-open everywhere: sink failures never block agent work and never disable the
  `telemetry.jsonl` path. The bounded `telemetry.jsonl(.1)` stream stays the operational
  record and is imported incrementally and deterministically by `/swarm report` (never
  renamed; content-derived synthetic ids make full rebuilds byte-identical).
- **`/swarm report`** (also `/swarm report --json`): bounded, deterministic query (first run performs an idempotent legacy-import into the local sink)
  with `--task` / `--session` / `--trace` / `--run` (the lane/dispatch batch axis) /
  `--since` filters, coverage disclosure (live vs imported vs quarantined rows), delegation
  begin/end pairing counts (unmatched begins disclosed, never fabricated), context-source
  savings aggregates, sink health, and a bounded chronological timeline. No store on disk →
  an explicit empty report, not an error.
- **Delegation pairing closes the background gap (#2244)**: `delegationCostRecordMaterial`
  now resolves Task-tool records (no `laneId`) to the pre-documented
  `sessionId\0callID` shape instead of throwing, so `already_terminal_without_event`
  settlements and the stale sweep emit the exactly-once recovered `delegation_end`
  (attribution from the durable record, `recovered: true`, deterministic `record_id` that
  can never collide with lane ids). `capSessionMap` gains the just-inserted self-eviction
  guard (#2244 item 2).
- **Honest savings attribution (#1990)**: new `context_source_attribution` event records
  `tokensReturned` and a floored `tokensSavedEstimate` only when cited-file token sizes are
  actually measured — unknown measurements are omitted entirely, never zero-filled; wired at
  the context-capsule injection hook.
- **#2184 residual into the event lifecycle**: new `verdict_row_pipe_recovery` event carries
  the fidelity class (`legacy-fidelity-safe` / `legacy-lossy`) for every recovered verdict
  row — identifiers and enums only, no row prose.
- Event catalog grows 59 → 61 kinds (contract doc, fixtures, and citations re-anchored);
  retention registry grows to 109 rows with the new `observability-events-sqlite` row.
