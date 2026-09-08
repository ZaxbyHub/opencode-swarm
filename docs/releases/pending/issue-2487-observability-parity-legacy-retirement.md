## Observability parity: live/import overlap suppression, sink kill switch, Node parity harness

The SQLite observability query authority double-counted: every event captured
live by the telemetry sink was re-imported as a second row by the report-path
`telemetry.jsonl` import, because the two ingestion paths allocated `event_id`
from disjoint spaces (random per-emission envelope ids vs content-derived
synthetic ids) and the import marker never accounted for live-captured lines.
`/swarm report` therefore doubled pairing counts, savings attribution, and
timeline entries.

- Live rows now carry a `line_hash` (migrations v38/v39) computed from the
  exact JSONL line bytes via the new `canonicalLineContent` helper; the report
  import skips segments whose hash already exists (counted in the new
  `skippedLive` result field and the report's `skippedLiveThisSync` disclosure).
  Import idempotency, PRR-001 recovered-end dedup, and live-row envelope
  fidelity are unchanged. Pre-v38 live rows get a one-time, same-transaction
  backfill (live rows only; reconstruction-guarded to byte-exact payloads).
- `SWARM_OBSERVABILITY_SINK_DISABLE=1` disables the local SQLite sink (mirrors
  `SWARM_OTLP_EXPORT_DISABLE`); the JSONL operational record and the
  rebuildable report import stay available — that is the rollback story.
- Sink health now surfaces the classified DB error category
  (`disk_full`/`read_only`/`corrupt`/`busy`) instead of only the constructor
  name, so a permanent failure is distinguishable from a transient one.
- New `bun run repro:2487` Node parity harness (CI smoke, Linux/macOS/Windows,
  next to repro:1873) proves close/reopen + restart parity for the
  observability sink (canonical-content compare; post-import duplicate-free),
  the plan-ledger SQLite backend (byte-identical canonical events, stable
  hash chain and state across close/reopen), and the coordination store
  (transactional state readback).
- `docs/sqlite-durable-state.md` gains a Storage compatibility matrix covering
  the nine durable stores: authority, retained legacy path, recovery/import,
  kill switch, and driver floors, plus the disclosed bounded residuals.
