# Core event store: bounded `.swarm/events.jsonl`, authoritative audit index, and no whole-file readers

`.swarm/events.jsonl` — the shared audit bus behind phase completions, gate
decisions, delegations, full-auto oversight, and recovery flows — previously
had **no size ceiling at all**: ~29 append sites across 24 modules wrote
directly, and nine production readers parsed the entire file, three of them
(coder-retry escalation, spec-drift commit verification, task-repair audit
idempotency) basing correctness decisions on arbitrary-age lookups. A long or
stuck session grew the file without bound (reproduced: 20k events → 1.8 MiB
with no cap firing; reader cost linear in total history).

It is now a **bounded single-file store** in the same shape as the #2037
context-telemetry store:

- A versioned `swarm-events-manifest` header (line 1) carries the folded
  lifetime aggregate — total events, per-type counts (≤64 keys + "other"),
  corrupt/dropped counters — and the retained window is capped at
  **2 MiB / 20k events / 7 days** (operational events; the correctness set is
  indexed instead of aged). Event lines themselves are preserved byte-for-byte
  (`event:` and `type:` discriminators both pass through untouched).
- **Every write holds an exclusive store lock** (`.swarm/events.lock`, wx
  create, stale-broken after 5 minutes) — appends, compaction, and finalize
  all serialize through it, so an append can never be lost to a racing
  compaction rewrite. Compaction is an atomic, pre-rename-validated rewrite
  (PID-scoped tmp + byte-verified rename) in bounded 512 KiB passes.
- **The four correctness-relevant event types**
  (`coder_retry_circuit_breaker`, `task_workflow_repaired`,
  `spec_drift_acknowledged`, `spec_drift_repaired`) are partitioned into an
  authoritative index (`.swarm/events-authority-index.json`) maintained at
  append time, **at fold time (before a line ever leaves the window)**, and at
  read time (self-healing). Compaction can no longer change a gate or recovery
  verdict; the only reachable absence is FIFO eviction past 20k index entries,
  which is counted and disclosed.
- All nine whole-file readers were replaced with bounded purpose-built
  queries: the context-budget turn estimate reads the manifest's lifetime
  counter (O(header)); curator/diagnose/steering/session-reflection read the
  bounded, manifest-stripped window with explicit coverage disclosure; the
  three authority consumers query the index (with a bounded window fallback
  for legacy sessions).
- `/swarm close` now finalizes the store (legacy drain to convergence +
  compaction + validation) **before** archiving, so archives are validated
  cuts; the authority index is archived and cleaned at the same boundary.
- A new CI gate (`bun run check:core-events`) ratchets against any new direct
  `events.jsonl` mention in `src/` outside the approved seam/lifecycle/
  archive-reader/prompt-doc set — a future producer cannot bypass the store.

Health: a new counts-only `core_events_health` telemetry event reports
accepted/compacted/retained/dropped/corrupt counts, authority-index size and
evictions, and byte figures on every compaction and close cut.

Legacy `.swarm` directories need no manual migration: header-less files read
bounded (newest window), authority lookups fall back to the window scan, and
the first maintenance pass migrates the file incrementally under the lock.

One small behavior change to know about: `/swarm diagnose` reports the
retained-window view with explicit coverage wording ("retained window —
compacted history excluded") when history has been compacted.
