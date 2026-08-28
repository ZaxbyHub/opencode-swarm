# Knowledge enforcement gate can no longer re-arm a satisfied directive — denials, staleness, and reset-session escapes all work now

## What changed

- The `knowledge_application` enforcement gate now treats an architect-issued
  application marker as acknowledging the knowledge ENTRY, not just the exact
  `(trace_id, entry_id)` pair it names. A fresh trace of an already-acknowledged
  entry in the same phase/task scope no longer re-arms a pending obligation
  (issue #2398). Only markers authored via the architect chat path
  (`source: 'architect_marker'`) discharge; delegate/reviewer-sourced markers and
  non-marker terminal outcomes still never satisfy the gate.
- The gate's denial budget (`max_gate_denials`) is now keyed by the stable
  entry-id set instead of the volatile trace/pair set, so trace rotation no
  longer resets the counter to 1 — the escape hatch is reachable and fires.
- A staleness release no longer clears the denial counter: a stale pair released
  and immediately re-armed by a fresh trace of the same entry continues the same
  budget instead of restarting it.
- `/swarm reset-session` is now a real escape from the gate: it durably releases
  the invoking session's pending architect-directive obligations in the receipt
  ledger (new audited release source `application_gate_session_reset_release`,
  event `knowledge_application_gate_session_reset_clear`) and clears the gate's
  in-memory denial state. Other sessions' obligations and the knowledge store
  are preserved.

## Why

The injector's retrieval cache key includes a hash of the latest user message,
so every message change mints a fresh `trace_id` for the same knowledge entry —
and the ack itself makes the cached block unverifiable, guaranteeing
re-injection. Before this fix, an acknowledgment closed only the exact pair it
named while the next trace of the same entry re-armed the obligation, the
denial budget reset on every rotation, and staleness releases reset it again:
a compliant architect could be denied `save_plan` (and every other high-risk
tool) indefinitely, with no working escape through `max_gate_denials`,
`gate_staleness_ms`, or `/swarm reset-session` (issue #2398).

## Migration notes

- Behavior for compliant architects: one acknowledgment per directive per
  phase/task scope is now sufficient. Re-surfaced traces of an acknowledged
  entry do not need to be re-acknowledged.
- A directive re-engages after a phase closure re-surfaces it (discharge is
  scoped to open phases/tasks) and for genuinely new entries — by design.
- An architect who refuses to acknowledge still sees bounded pressure: the
  denial-limit escape fires every `max_gate_denials + 1` denials and allows the
  action through.
- Residual (unchanged, by design): the injector still re-displays
  acknowledged entries under fresh traces (reinforcement exposure), which
  appends receipt-ledger membership rows until existing grace-day/phase-close
  compaction reclaims them. The gate no longer amplifies that into a lockout.
