# async lifecycle r11–r13 audit repair II: crash-safe terminal closeout

## What

Second batch of the independent source audit repairs for the native
OpenCode-2.3 async subagent lifecycle: the terminal claim and the business
closeout effects are now SEPARATE durable concerns.

### P0-3 — completion side effects were lost after a crash

The completion observer ran its business closeout effects (context map,
sounding-board verdict, pipeline advisory, delegation_end telemetry, parent
advisory) only while `isFreshTerminalClaim === true` — an in-process flag. A
crash between the durable terminal claim and any effect permanently lost that
effect; after the restart the replayed completion was a duplicate and the
r12 non-coder failure early-return even lost the failure message to the
parent forever.

This adds a versioned closeout journal on the durable delegation record
(`closeout`: terminal event id + per-effect ack states for `delegation_end`,
`context_map`, `sounding_board`, `pipeline_advisory`, `parent_advisory`).
Each effect is journal-gated instead of fresh-claim-gated, and is only acked
AFTER it was durably established. Failed effects stay re-drivable. A bounded
recovery pass (`reconcileTerminalCloseouts`) runs at every background
maintenance point through a registered reconciler (the live observer), so
recovery does not depend on a new host completion event — and never re-enters
the record currently being processed. Legacy records without a journal are
re-driven once and then journaled.

### P1-2 — the context map reported success before the workflow proved it

The context-map success summary was written before coder settlement and
Stage-B ingestion, with a blanket `final_status: 'completed'` (rendered as
`approved`). It now runs only after settlement AND ingestion proved the
business outcome: a rejected reviewer verdict, a failed test-engineer run, a
failed settlement or worktree merge, or a retryable ingestion never appears
as `approved` (no summary is written for them; a terminally negative
ingestion closes the step so recovery cannot re-drive a success write). A
crash between the ingestion commit and the summary write is re-driven by
recovery (the write itself is idempotent — `task_history` is keyed by task
id). `files_touched` now carries the coder's declared files when available.

### P1-5 — delegation_end / execution-attempt pairing survives crashes

The `delegation_end` pairing observation is journal-gated (exactly-once per
terminal across duplicates, replays, and process restarts; the deterministic
`record_id` keeps cost rollups deduped). Failed and cancelled delegations
keep their failure classification — never `success`.

### P2-2 — sounding-board and pipeline advisories are durable

The r12 closeout pushed sounding-board and pipeline advisories only to a
parent session live in memory. They are now stored in a bounded, eventId-
deduped `closeoutAdvisories` list on the delegation record — independent of
the single `advisoryInbox` slot (a terminal can carry several distinct
messages without clobbering) and of the parent session's liveness. The
prepare/release/ack delivery contract drains both slots.

## Why

A trusted terminal event is not the same as a completed closeout. Between
claim and effect sits ordinary crash surface (process kill, provider
restart, disk full); every effect that silently vanished there was either an
operator message that never arrived or telemetry that broke the
`delegation_begin`/`delegation_end` pairing. The journal makes each effect
individually acked and recoverable without exactly-once claims about
non-transactional sinks (telemetry remains at-least-once per journal step).

## Testing

- tests/unit/background/completion-observer-closeout-recovery.test.ts —
  controlled crash injection (claim→advisory, claim→delegation_end, ingestion
  commit→context-map) with fresh observer instances; journal fence; durable
  advisory dedup and no-clobber.
- tests/unit/background/completion-observer-terminal-closeout.test.ts — the
  P1-2 matrix (real Stage-B success writes exactly one `approved` summary;
  settlement-failure, rejected verdict, and retryable ingestion write none).
- tests/unit/background/async-lifecycle-integration-matrix.test.ts — the
  success and restart scenarios now use real Stage-B fixtures.
- All 173 background suites pass per-file (one pre-existing unrelated
  failure in stage-b-dispatch-binding-store-2829 exists on the base commit
  as well).
