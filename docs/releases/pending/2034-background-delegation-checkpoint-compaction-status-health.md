# Background delegation recovery bounded by checkpoint/tail compaction + durable status health

## What

Resolves #2034 (and surfaces #1659's status visibility): the background-delegation
recovery ledger (`.swarm/background-delegations.jsonl`) no longer grows without
bound until the 4 MiB fail-closed recovery guard silently disables automatic
recovery.

- **Checkpoint + bounded tail.** When the ledger passes the 1 MiB compaction
  high-water mark (checked lazily under the existing store lock after every
  append), the folded authoritative state — active ownership, terminal results,
  coder settlement, pending advisory inbox — is checkpointed into
  `.swarm/background-delegations.checkpoint.json` (schema version, monotonic
  sequence, writer id, root binding, cut position + digest, payload checksum,
  live records + compact closed summaries + all-time audit counters), published
  via `.swarm/background-delegations.manifest.json`, and the ledger is rolled to
  the post-cut tail. Normal operation stays far below the unchanged 4 MiB guard.
- **Crash-safe publication, converging interpretations.** Publication order is
  checkpoint → manifest → roll (each a durable temp+fsync+rename with Windows
  EPERM/EBUSY retries). Every crash window either folds to the same
  reconstructed state or fails closed with a stable typed reason — a rolled tail
  that grows past the old cut, rewritten bytes, or a mid-publication crash can
  never produce partial ownership state or a permanent un-acked uncertainty
  without actual corruption.
- **Exactly-once preserved across compaction.** Closed correlations are retained
  as compact summaries that keep every gate-relevant field (lane identity,
  workspace, worktree, result scalars, and settled `observedFiles` — the
  executed-contract audit artifact) and drop only the large bodies (prompt
  text — its sha256 `promptHash` is retained, `taskChangeContext`, and result
  text/error — their sha256 `digest` is retained). Duplicate starts
  (summary-aware launch identity), terminal replays, settlement resumes,
  advisory delivery, and ingestion claims stay idempotent across restart and
  compaction; closed summaries younger than 72 h are never evicted to meet the
  checkpoint byte budget.
- **Fail-closed posture unchanged.** Legacy uncheckpointed ledgers over 4 MiB
  still return `uncertain` with the same reason strings. Corrupt
  checkpoint/manifest/sequence/checksum states fail closed, refuse mutations,
  and name the exact repair procedure. Circuit-breaker and transient-retry state
  is never serialized (stays invocation-owned).
- **Durable status health (#1659).** A new fold-free health artifact
  (`.swarm/background-delegations-health.json`) records ledger bytes/limit/
  pressure band, checkpoint state, recovery source, live-set counts, and the
  most recent durable uncertainty (with a repair hint) — and `/swarm status`
  renders a `Background Delegations` section (also in the no-plan branch, only
  when there is something to report, so clean-repo output is unchanged).
  Startup orphan recovery records its scan outcome, so an incident stays
  visible after the in-memory failure is gone.
- **Close/archive wiring.** `/swarm close` archives the full delegation store
  set (ledger + checkpoint + manifest + health artifact) for forensics and
  deliberately leaves it in place — the store is cross-session state and
  compaction, not close, is its bounded-retention mechanism.
- **Documented bounds.** 4 MiB fail-closed recovery guard, 1 MiB compaction
  high-water mark, 2 MiB checkpoint byte budget with a live-record cap 2048,
  and a 72 h closed-summary age floor — all validated in code, and the
  fragment's copies of these figures are flagged by drift-check when they
  drift from the source constants.
- **Known limitation — version downgrade.** A pre-#2034 plugin version opening
  a repo whose ledger this version compacted reads the rolled tail as the
  entire ledger (it has no manifest knowledge), silently missing pre-cut
  records. Downgrading across a compacted repo is unsupported; re-upgrade
  restores full recovery.

## Why

The store was designed assuming "each dispatch leaves a small, fixed number of
lines"; coder settlement, advisory inbox, and ingestion CAS lifecycles grew each
lifecycle to ~6-10 full snapshots of 1-30 KB, so ~150-400 dispatches reach the
4 MiB recovery bound. Recovery of a tiny live set was permanently disabled by
dead history, and nothing surfaced it.

## Verification

- 60 new focused tests across 10 files: >4 MiB compaction/recovery, publication
  crash matrix (rename-seam simulated, including checkpoint/manifest checksum
  mismatches), exactly-once across compaction (incl. advisory lease expiry),
  concurrency + real Windows-rename retry loops, health artifact, status
  rendering, a production `handleStatusCommand` test, and orphan-recovery
  observation (seam + real hook run).
- Existing focused suites re-run green (pending-delegations*, coder
  reservations/crash-recovery, completion-observer*, init-orphan-recovery*,
  delegation-gate background suites, dispatch-lanes, status service/command,
  CLI dispatch, adversarial command-services).
- `bun run typecheck`, `bun run lint` (no new warnings), `bun run build`,
  Node ESM `import('./dist/index.js')`, `bun run drift:check` — all clean.
