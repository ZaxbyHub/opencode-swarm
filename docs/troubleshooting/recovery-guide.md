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

**Why:** OpenCode added experimental background subagents — calling the `Task` tool with
`background=true` is enabled upstream by either
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` or the umbrella
`OPENCODE_EXPERIMENTAL=true`.
A background `Task` returns a **running placeholder immediately** and delivers the real
result **later** via a synthetic parent message. Swarm must treat the placeholder as a
handoff rather than completion, then correlate and settle the later terminal result before
it can affect workflow state or evidence. By default, swarm **fail-closed-blocks**
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
`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` or
`OPENCODE_EXPERIMENTAL=true`.

For background coder delegations, a trusted terminal completion must additionally
prove an immutable clean baseline, attribute the exact changed files, and settle any
standard isolated worktree into the project root before coder evidence or workflow state
is published. Successful ingestion advances an idle task to `coder_delegated`, preserves
later states idempotently, stores task-keyed modified files for concurrent review routing,
and queues a durable parent-architect completion advisory. Unknown attribution, workspace
identity drift, or a partial/failed worktree merge remains unconsumed and cannot satisfy
the coder gate.

If startup cannot read or validate the primary ledger, fallback artifacts, merge-status
owners, provisioning markers, or the Git ownership tags used as a last-resort guard for
an uncorrelated isolated coder, orphan recovery fails closed with an
`init-orphan-recovery` advisory and performs no destructive cleanup. Standard worktree
creation publishes a provisional marker under the same lifecycle lock held by recovery,
closing the creation-to-ledger gap. Size/count overflow has the same behavior. Recover or
inspect the reported owner data before repairing the store, removing obsolete
`swarm-preserved-owner/*` tags, and retrying startup.

### Readiness checklist before changing the default

`hooks.background_subagents` remains `false` by default while OpenCode requires either
experimental environment flag. A future compatible release may change that default only
after all of the following are true:

1. A stable OpenCode release exposes `background` without
   `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` or `OPENCODE_EXPERIMENTAL`, and official
   docs/release notes explicitly graduate the completion contract from Experimental.
2. The minimum supported OpenCode and `@opencode-ai/plugin` / `@opencode-ai/sdk` versions
   are pinned to that stable contract, with older hosts still failing closed.
3. Placeholder correlation and terminal success/error/cancel delivery are documented as
   durable and exactly once across restart/resume, or swarm explicitly bounds and tests
   any weaker upstream guarantee.
4. Coder, reviewer, and `test_engineer` tests prove exact-parent state, task-keyed files,
   evidence/receipts, stale/error/duplicate rejection, and durable mid-turn advisories.
5. Background mode composes with parallel-first scheduling and standard worktree
   isolation, including reverse-order completion and merge-conflict recovery.
6. Windows, macOS, and Linux pass TUI, Desktop/Node-sidecar, Bun, cancellation, and
   restart coverage.
7. The default flip ships with migration/release notes and retains an explicit user
   hard-off. It must not be combined speculatively with another concurrency-default flip.

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

## 9. Orphaned Worktree Recovery

**Symptom:** Stale `.swarm-worktrees/<sessionId>/` directories remain after a session crashes or is terminated uncleanly. These orphaned worktrees accumulate over time and consume disk space.

**What happens:** On session start, the plugin runs an orphan recovery scan that:
1. Reads active sessions from the swarm state ledger
2. Identifies `.swarm-worktrees/<sessionId>/` directories whose sessions are no longer active
3. Removes the orphaned worktree directory and its associated git branch (`sw-lane-<sessionId>/*`)
4. Writes an advisory to `.swarm/advisories/init-orphan-recovery.json` describing what was cleaned up

The orphan recovery is registered during plugin initialization and started from the wrapper-owned post-resolution queue, so it cannot block the plugin from loading.

**Files cleaned up:**
- `.swarm-worktrees/<sessionId>/` directory
- Git branch `sw-lane-<sessionId>/*` for each lane under that session

**Advisory file:** `.swarm/advisories/init-orphan-recovery.json` contains the recovery report. The session-start hook consumes this file and pushes its contents to `pendingAdvisoryMessages`, then deletes the file after consumption. To inspect what was cleaned up after a session restart, check the advisory content before it is consumed.

**Manual cleanup:** If you need to clean up orphaned worktrees manually:
```bash
# List all worktrees
git worktree list

# Remove a specific orphaned worktree
git worktree remove .swarm-worktrees/<sessionId>/<laneId>

# Also remove the branch
git branch -D sw-lane-<sessionId>-<laneId>
```

---

## 10. Recovering from Background Stage B Gate Batches

When `hooks.background_subagents: true` is enabled, native background `Task`
dispatches to gate-bearing agents are tracked in `.swarm/background-delegations.jsonl`.
Coder, reviewer, and `test_engineer` completions are correctness-critical: they only
advance `.swarm/evidence/{taskId}.json` and `taskWorkflowStates` after the
trusted synthetic terminal envelope is correlated to the original parent
session and the workspace snapshot still matches.

**Pending coder/reviewer/test gate:** do not mark the task complete while the matching
background row is `pending` or `running`. Wait for the synthetic completion. The
task should remain before `tests_run`, so `update_task_status(... completed)`
continues to block.

**Primary-ledger write failure:** a launched dispatch whose primary append fails is
owned by an exact per-correlation artifact under
`.swarm/background-delegation-fallback/`. The completion observer promotes that
artifact atomically before terminal handling. Init orphan recovery treats both
primary and fallback owners as live, so it will not delete their standard
worktrees or branches after a process restart.

**Consumed row:** `consumed` means the terminal background completion was accepted and
applied exactly once. For coders, worktree settlement and task-keyed modified-file
attribution completed before coder state/evidence publication. For reviewer/test rows,
gate evidence, review receipts when applicable, and the live Stage B state machine were
updated. If both reviewer and `test_engineer` evidence rows exist, completion can proceed
normally.

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

**Preserved coder settlement:** an isolated coder merge conflict, failed merge,
or failed recovery-identity check remains unconsumed with its worktree, branch,
operation identity, and observed-file set intact. Resolve the reported recovery
condition and replay the same trusted completion; never mark the task complete
from the child transcript alone.

## 11. Wedged Coder Settlement (CODER_DISPATCH_IN_PROGRESS)

Foreground coder dispatches are fenced by a durable write-ahead record at
`.swarm/coder-settlements/{taskId}.json` (`DISPATCHED` → `PREPARED` →
`COMMITTED`, or `ABORTED`). When the dispatch completes normally, its
completion hook settles the record. If that completion never arrives — the
OpenCode process was killed mid-dispatch, the Task call was cancelled without
a completion hook, or (on plugin versions ≤ 7.141.1) a gate denied the
dispatch after the record was written — the record stays `DISPATCHED` and
every later dispatch for that task is refused with
`CODER_DISPATCH_IN_PROGRESS` / `CODER_SETTLEMENT_IN_PROGRESS`. On the same
host process, `update_task_status` and `/swarm close` are paused by the same
guard, so the session cannot progress on its own.

**Recovery:**

- `/swarm recover [task_id]` — settles stale records whose owning process is
  gone. Human-only; the swarm's agents already self-heal this case via
  `update_task_status`.
- `/swarm recover <task_id> --force` — additionally releases ownership keys
  still held by the current process. Only use when no coder dispatch is
  genuinely still running: a still-running dispatch's late completion will
  report `CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT`, which is safe to ignore.
- `/swarm reset-session` — recovers all stale coder settlements as part of
  clearing session state.
- Settlements owned by another live OpenCode process (a different pid on the
  same `.swarm/`) are never interrupted: close that instance or run
  `/swarm recover` there.

**Never delete or hand-edit `.swarm/coder-settlements/*.json`.** The record
carries the launch baseline that attributes the coder's changes to the task;
deleting it discards attribution and can strand review debt. `/swarm diagnose`
reports every non-terminal settlement with its owner liveness and the exact
remediation.

---

For architecture details, see `docs/plan-durability.md`.
