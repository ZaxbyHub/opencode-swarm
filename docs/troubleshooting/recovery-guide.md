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

# Option 2: Restore from .swarm/SWARM_PLAN.json by copying it to `.swarm/plan.json`
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
# Restore from .swarm/SWARM_PLAN.json by copying it to `.swarm/plan.json`
```

---

## 4. When to Use reset-session

**Use when:**
- Session state is stale after a crash
- Agent sessions are stuck
- Hash mismatch recurs after rebuild

**Do NOT use for:**
- Ledger corruption (use rebuild/import instead)
- Missing plan files (use `importCheckpoint()` programmatically or restore from .swarm/SWARM_PLAN.json instead)

---

## 5. When to Rely on Rebuild/Import

**Use rebuild when:**
- `plan.json` is missing or invalid
- Ledger is intact but plan projection is corrupted

**Use import when:**
- Starting fresh in a new repo with an existing `.swarm/SWARM_PLAN.json` checkpoint
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
evidence **before any review/test output exists**. Until swarm can correlate the deferred
completion safely (tracked as a separate, spike-gated change), swarm **fail-closed-blocks**
background delegations for any swarm role (reviewer, test_engineer, coder, explorer, etc.).
Swarm never silently rewrites `background` to `false` — the unsupported capability is
surfaced explicitly.

**Action needed (default):** Re-issue the delegation **without** `background` (or with
`background: false`). Foreground swarm delegations are unaffected. Non-swarm OpenCode
`Task` usage (e.g. the native `general` agent) is not blocked. The pre-dispatch block runs
in `tool.execute.before`, so OpenCode rejects the call before the background task launches;
a belt-and-suspenders check in `tool.execute.after` ensures a running placeholder never
advances workflow state even if it slips through.

### Opt-in tracking (PR 2 Stage A)

Setting `hooks.background_subagents: true` lifts the block: background swarm dispatches are
**allowed and tracked** as durable pending records in `.swarm/background-delegations.jsonl`,
and a read-only observer logs the upstream completion signal (the trusted `synthetic` task
envelope) when `OPENCODE_SWARM_DEBUG=1`. Unresolved pendings are transitioned to `stale`
after `hooks.background_pending_timeout_minutes` (default 30); the on-disk log is append-only
and not compacted in Stage A.

> **Stage A is observe-only:** a background completion does **not** advance workflow gates or
> record gate evidence yet. This stage exists to confirm the runtime completion signal before
> gate-affecting ingestion (Stage B) is enabled. Until then, background swarm delegations are
> tracked but do not satisfy reviewer/test_engineer gates — use foreground delegations when you
> need a gate to advance. Requires upstream `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

---

For architecture details, see `docs/plan-durability.md`.
