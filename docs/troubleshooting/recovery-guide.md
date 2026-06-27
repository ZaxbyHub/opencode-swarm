# Operator Recovery Runbook

This guide covers common recovery scenarios for the opencode-swarm plan durability system.

---

## 1. Missing plan.json

**What happens:** `loadPlan()` detects missing `plan.json` and automatically rebuilds from the ledger.

**Manual recovery:** If the ledger is also missing:
```bash
# Option 1: Use importCheckpoint() programmatically
import { importCheckpoint } from './src/plan/checkpoint'
await importCheckpoint()

# Option 2: Restore from .swarm/plan-export/SWARM_PLAN.json by copying it to `.swarm/plan.json`
```

---

## 2. Stale Session After Restart

**Symptom:** `[loadPlan] plan.json is stale (hash mismatch with ledger)` on startup.

**What happens:** `loadPlan()` detects hash mismatch between `plan.json` and the ledger, then rebuilds from ledger automatically.

**If it recurs:**
```bash
/swarm reset-session
```

---

## 3. Ledger Mismatch / Hash Mismatch

**Symptom:** `[loadPlan] plan.json is stale (hash mismatch with ledger)` in logs.

**Cause:** `plan.json` was written without going through the ledger (e.g., manual edit).

**Fix:** Automatic rebuild from ledger. If rebuild fails:
```bash
# Restore from .swarm/plan-export/SWARM_PLAN.json by copying it to `.swarm/plan.json`
```

---

## 4. When to Use reset-session

**Use when:**
- Session state is stale after a crash
- Agent sessions are stuck
- Hash mismatch recurs after rebuild

**Do NOT use for:**
- Ledger corruption (use rebuild/import instead)
- Missing plan files (use `importCheckpoint()` programmatically or restore from `.swarm/plan-export/SWARM_PLAN.json` instead)

---

## 5. When to Rely on Rebuild/Import

**Use rebuild when:**
- `plan.json` is missing or invalid
- Ledger is intact but plan projection is corrupted

**Use import when:**
- Starting fresh in a new repo with an existing `.swarm/plan-export/SWARM_PLAN.json` checkpoint
- Ledger is also missing/corrupted and you have a checkpoint backup

---

## 6. Ledger Corruption

**Symptom:** `[ledger] Corrupted suffix quarantined` warning.

**What happens:** Bad suffix moved to `.swarm/plan-ledger.quarantine`, replay continues from last valid event.

**Action needed:** None required — replay is self-healing. Monitor quarantine file size; if it grows large, investigate the corruption source.

---

## 7. Background Subagent Task Rejected

**Symptom:** A delegation throws `SWARM_BACKGROUND_TASK_BLOCKED: OpenCode background subagents ...`.

**Why:** OpenCode v1.16.2 added background subagents — calling the `Task` tool with
`background=true` (enabled upstream by `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`).
A background `Task` returns a **running placeholder immediately** and delivers the real
result **later** via a synthetic parent message. Swarm's delegation gate treats a `Task`
result as completion, so consuming the placeholder would advance Stage B and record gate
evidence **before any review/test output exists**. By default, swarm **fail-closed-blocks**
background delegations for any swarm role (reviewer, test_engineer, coder, explorer, etc.).
Swarm never silently rewrites `background` to `false` — the unsupported capability is
surfaced explicitly.

With `hooks.background_subagents: true`, this is no longer future work for
Stage B reviewer/test_engineer gates: swarm tracks the background dispatch and
waits for trusted terminal completion ingestion instead of treating the running
placeholder as completion.

**Action needed (default):** Re-issue the delegation **without** `background` (or with
`background: false`). Foreground swarm delegations are unaffected. Non-swarm OpenCode
`Task` usage (e.g. the native `general` agent) is not blocked. The pre-dispatch block runs
in `tool.execute.before`, so OpenCode rejects the call before the background task launches;
a belt-and-suspenders check in `tool.execute.after` ensures a running placeholder never
advances workflow state even if it slips through.

### Opt-in tracking and Stage B ingestion

Setting `hooks.background_subagents: true` lifts the block: background swarm dispatches are
**allowed and tracked** as durable pending records in `.swarm/background-delegations.jsonl`,
and the observer ingests trusted `synthetic` task envelopes into that advisory ledger when
they correlate to a real dispatch. Unresolved pendings are transitioned to `stale` after
`hooks.background_pending_timeout_minutes` (default 30); the on-disk log is append-only.

For Stage B reviewer/test_engineer background delegations, the completion is no
longer advisory-only after PR2: it must correlate to a pending record, match the
parent session, pass workspace freshness checks, and record durable gate evidence
before live workflow state can advance. Requires upstream
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

---

## 8. Recovering from Async Advisory Lane Batches

Async advisory lanes launched with `dispatch_lanes_async` are tracked in
`.swarm/background-delegations.jsonl` and joined with `collect_lane_results`.
They are advisory only: their results can inform the architect, but they never
advance reviewer, test, council, or phase-completion gates.

**Lost `batch_id`:** inspect the architect transcript for the
`dispatch_lanes_async` result and reuse its `batch_id`. If the transcript is not
available, inspect `.swarm/background-delegations.jsonl` for recent records with
a matching `mode`, `laneId`, or `parentSessionId`, then run
`collect_lane_results` for the recovered batch. If the batch cannot be
identified, relaunch the advisory lanes with a new explicit `batch_id`.

**Stale batch:** `collect_lane_results` reports stale counts when lanes exceed
the async pending timeout. Treat stale lanes as missing advisory evidence, then
rerun only the affected read-only lanes under a new batch. Do not treat stale
advisory lanes as completed gate evidence.

**Cancelled batch:** if `cancel_pending: true` was used, the cancelled rows are
terminal. Relaunch a new batch if the advisory evidence is still needed. A
cancelled advisory batch is not a failure of any workflow gate.

**Orphaned pending delegation:** if a parent session was closed or the child
session disappeared, run `collect_lane_results` with `wait: false` to collect any
finished lanes, then run it again with `cancel_pending: true` to mark the
remaining orphaned rows as cancelled. Relaunch any required advisory lanes with a
fresh `batch_id`.

**Cross-session mismatch:** `collect_lane_results` filters by the current parent
session when the tool context supplies one. If a batch was launched in a
different session, collect it from that parent session, or relaunch the advisory
lanes in the current session.

**Preview or truncated output:** `dispatch_lanes`, `dispatch_lanes_async`, and
`collect_lane_results` return bounded `output` previews. When a lane result has
`output_ref`, recover the full text with `retrieve_lane_output` before parsing
findings, candidates, JSON member responses, or verification conclusions. If a
lane result is `output_degraded`, `transcript_incomplete`, truncated without a
usable ref, stale, cancelled, or failed, treat it as missing advisory evidence and
re-dispatch a narrower lane or mark the affected coverage UNVERIFIED.

## 9. Recovering from Background Stage B Gate Batches

When `hooks.background_subagents: true` is enabled, native background `Task`
dispatches to gate-bearing agents are tracked in `.swarm/background-delegations.jsonl`.
Reviewer and `test_engineer` completions are correctness-critical: they only
advance `.swarm/evidence/{taskId}.json` and `taskWorkflowStates` after the
trusted synthetic terminal envelope is correlated to the original parent
session and the workspace snapshot still matches.

**Pending reviewer/test gate:** do not mark the task complete while the matching
background row is `pending` or `running`. Wait for the synthetic completion. The
task should remain before `tests_run`, so `update_task_status(... completed)`
continues to block.

**Consumed Stage B row:** `consumed` means the terminal background completion was
accepted and applied to gate evidence, review receipts when applicable, and the
live Stage B state machine. If both reviewer and `test_engineer` evidence rows
exist, completion can proceed normally.

**Stale workspace:** a Stage B row becomes `stale` when the git head, dirty-tree
hash, PR head SHA, or project directory no longer matches the dispatch snapshot.
Treat the stale result as not reviewed. Re-dispatch the affected reviewer or
`test_engineer` gate against the current workspace; do not reuse the stale gate
as evidence.

**Error row:** terminal `error` records do not advance gates. Inspect the stored
result/error text, fix the underlying problem, and re-run the missing Stage B
agent. The task is not complete until the required gate evidence is present.

**Ingestion error:** `ingestion_error` means the terminal background result was
trusted and stored, but swarm could not apply the evidence, receipt, or workflow
state update. Fix the reported local storage/problem and replay the trusted
completion event if available, or re-dispatch the missing Stage B gate. Do not
count the gate as satisfied until the row becomes `consumed`.

---

For architecture details, see `docs/plan-durability.md`.
