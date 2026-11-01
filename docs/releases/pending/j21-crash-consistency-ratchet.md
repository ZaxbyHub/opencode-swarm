---
issue: 2969
---

# Crash-consistency ratchet: safer Full-Auto/OTLP writes, Check 10, doctor --integrity (#2969, Workstream J slot J21)

Two durable-state writers lost the canonical-writer contract on failure:
`src/full-auto/state.ts` renamed its temp with a bare `renameSync` (no retry
on Windows-transient EPERM/EBUSY, no temp cleanup on failure) and the OTLP
exporter's "fallback" clobbered the canonical spool/state file
non-atomically, swallowed the error, and leaked the temp. Both now ride one
shared bounded-retry helper (`renameSyncWithRetry`, exported from
`src/utils/atomic-write.ts`); the non-atomic fallback is gone; terminal
failures clean their temp and are counted once at the record-owning boundary
(`write_retry_exhausted` vs a separate `state_write_failed` counter), and the
fail-open contract is preserved end to end.

`bun run check:invariants` gains **Check 10**, the raw-rename/raw-rm ratchet
(`scripts/raw-write-allowlist.txt`): every remaining bare `renameSync` in
`src/**` and raw `rm` in the db-touching test surface is frozen behind a
per-file count quota that can only shrink (growth in either dimension
without an `# APPROVED-NEW:` marker fails; dead entries fail; the initial
freeze is bootstrap-gated). Burn-down is tracked by the shrinking count on
epic #2945. (The issue's "Check 9" number was already taken by #2946 — the
ratchet lands as Check 10.) `/swarm config doctor --integrity` now reports —
never repairs — torn ledger/events tails, temp-artifact leftovers, stale
locks (including the report-only live-pid sub-class), orphaned `.bak` files,
and same-id memory-family divergences, with per-category counts and a total.
`docs/plan-durability.md` documents the flag and a crash-consistency fsync
policy table whose flip rule requires a measured Windows cold-FS latency
first; this PR changes no fsync behavior.
