# Task recovery runbook

A compact operator runbook for restart policy reconciliation and task recovery
(issues #2668 and #2665): one shell-correct invocation per supported shell, the
meaning of each owner-visible status category, and the boundary between
deterministic repair and an external side effect that needs human
reconciliation.

## Shell-correct invocations

Recovery runs through the host command path (the OpenCode TUI/GUI command line). When driving OpenCode headless, the shell you launch from changes how the `/swarm …` message argument must be written:

| Surface | Invocation | Why |
|---|---|---|
| Host command path (TUI/GUI) | `/swarm recover <task_id>` | Typed verbatim into the host — no shell rewrites it. |
| PowerShell (headless) | `opencode run --dir <project-dir> '/swarm recover <task_id>'` | Single quotes keep the `/swarm …` message argument literal in PowerShell parsing. |
| Git Bash / MSYS (headless) | `opencode run --dir <project-dir> "//swarm recover <task_id>"` | The leading slash is **doubled**: MSYS path conversion rewrites a single leading-slash argument to a path under the Git install root (`C:/Program Files/Git/swarm recover …`) before OpenCode ever sees it. |
| Shell-neutral CLI | `bunx opencode-swarm run recover <task_id> [--force]` | Identical in every shell; `--force` is an operator assertion that no dispatch is genuinely in flight. |

For coordination readiness, use the same forms with `recover --coordination`
(for example, `bunx opencode-swarm run recover --coordination`). This retries a
failed or timed-out post-resolution coordination attempt; it must not be used
while the previous attempt is still unsettled.

Known MSYS argument friction: do **not** set `MSYS_NO_PATHCONV=1` for the whole invocation. It silences the `/swarm` rewrite but also stops converting `--dir /c/...` style arguments, so every project-path resolution breaks. Doubling only the message argument's leading slash is the shell-correct form. There is deliberately no runtime shell detection — the forms above are documented, not sniffed.

`/swarm diagnose` follows the same rules (`'/swarm diagnose'` in PowerShell, `"//swarm diagnose"` in Git Bash, `bunx opencode-swarm run diagnose` on the CLI).

## Restart, inspect, recover

Use this order after a crash, host restart, or a report that policy and
execution state disagree:

1. Restart or reopen the host and allow snapshot coordination to report a
   readiness state. A `running` or otherwise unsettled attempt is still
   unknown; do not start a second coordination retry.
2. Inspect `/swarm status` for coordination and background-work state, then
   run `/swarm diagnose` for read-only task classifications. Use
   `get_approved_plan` to inspect the plan replay and
   `get_qa_gate_profile` to inspect the persisted QA profile for the exact plan
   identity. The latter deliberately excludes session-only QA overrides.
3. If the projection is missing, stale, or malformed, do not edit
   `.swarm/plan.json` or `.swarm/plan.md`. `loadPlan()` replays
   `.swarm/plan-ledger.jsonl`, quarantines an invalid ledger suffix, and
   regenerates valid derived projections. If replay cannot prove identity,
   leave the plan unknown and escalate for manual reconciliation.
4. If coordination is `superseded`, `failed`, or `timed_out` and the prior
   attempt has settled, run `/swarm recover --coordination` and inspect status
   again. A superseded attempt deliberately remains non-successful so its stale
   recovery cannot suppress a current-generation retry.
5. For a task classified as `stale` or `live_wedge`, run
   `/swarm recover <task_id>`. This consumes only the receipt-backed local
   repair and is idempotent. For `ambiguous`, `corrupt`, or any uncertain
   external effect, stop and reconcile with the owning process, provider, or
   worktree before asserting success.

Restart restores durable plan and QA policy, not execution authority. Session
overrides, active ownership, live lease authority, child handles, timers, and
retry/circuit state from the prior process are not evidence that a new process
may execute. Durable lease records and expiry tombstones remain recovery
evidence, not permission to reuse the lease.
An expired lease is not proof of owner absence; maintenance releases it only
when the owner-absence evidence is sufficient. A late result from an older
workflow generation is rejected without clearing newer work.

### Owner-visible restart states

| State | Meaning | Operator action |
|---|---|---|
| `stale` | The recorded owner is gone and local repair is deterministic. | Run `/swarm recover <task_id>`; re-check status. |
| `ambiguous` | A live foreign or current-process owner may still be executing, so the external effect is uncertain. | Do not force a foreign owner; inspect that process/provider. |
| `corrupt` | A receipt or projection cannot be trusted. | Preserve the evidence, replay from the ledger where possible, and reconcile manually if identity remains unproven. |
| `live_wedge` | Settlement succeeded but the Stage A receipt is missing despite green proof. | Run task recovery; it records the justified repair and never reruns the coder. |
| expired lease | The lease deadline passed, but expiry alone does not establish owner absence. | Wait for corroboration; do not treat the lease as freely reusable. |
| old-generation late result | A result belongs to a prior restart generation. | Reject it; preserve the newer generation's state. |
| `running` / `superseded` / `timed_out` coordination | Readiness is not yet authoritative, the attempt lost its generation, or the bounded attempt timed out. | Do not overlap retries; use `--coordination` only after the prior attempt settles. |

The distinction between `ambiguous`, `corrupt`, and `stale` is intentional:
unknown facts remain visible rather than being converted into a successful
terminal state. See [plan durability](../plan-durability.md) for the ledger and
projection contract.

## Status categories

`/swarm diagnose` reports each task's recovery facts under the **Coder Settlements** row using these categories (with the task, its owning transition id, and its workflow generation):

- **missing** — no durable receipt exists for the task (no settlement WAL, no evidence workflow). Nothing to repair; dispatch the task normally and re-check.
- **stale** — a settlement WAL names an owning transition whose process is gone. Deterministic repair via `/swarm recover <task_id>` is allowed and idempotent. When the WAL's generation fence no longer matches the workflow generation, the stale receipt cannot be consumed by a normal settle — recovery is the only deterministic path.
- **ambiguous** — the dispatch may genuinely be in flight: owned by a live foreign process (another OpenCode instance) or registered in this process. The external effect stays uncertain; close that instance (or run recovery there), never force a foreign owner from here. `--force` releases only *this* process's ownership and is an operator assertion, not a status claim.
- **corrupt** — the durable receipt is unparseable. Recovery refuses corrupt facts instead of rewriting them: inspect `.swarm/coder-settlements/<task_id>.json` and reconcile manually. Do not delete or hand-edit the file.
- **live_wedge** — the task settled but its Stage A receipt is missing while green post-settlement pre-check proof exists. `/swarm recover <task_id>` deterministically writes the missing `stage_a_passed` transition — it never re-runs the coder and never edits evidence files. Without green proof it reports `skipped_not_green` and asks for `pre_check_batch` first.
- **healthy** — terminal receipts agree with the workflow state; reported as a count, nothing to do.

## Deterministic repair vs external side effects

Deterministic repair — dead-owner settlement recovery and the wedged Stage A repair — only rewrites local durable state the receipts already justify. It never resolves an external side effect. These stay uncertain even when local state is repaired and need a human to reconcile against the other process or provider:

- a **live foreign dispatch** (another OpenCode instance owns the WAL — this host never interrupts it);
- an **unattributable worktree** (`CODER_SETTLEMENT_RECOVERY_UNCERTAIN` — workspace changes could not be attributed to the declared scope);
- a **late completion after `--force`** — the released dispatch may still land and report `CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT`; that error is expected and safe to ignore, but whether the coder's external effect applied is a fact only the operator can confirm.

Repair receipts are linked to their predecessors: a successful settlement recovery emits a `recovered` event carrying `previousTransitionId`/`previousState`/`expectedGeneration` (the wedged dispatch it superseded), and a Stage A repair emits a `repaired` event carrying `predecessorTransitionId` (the transition that wedged the task) — both land in `.swarm/events.jsonl`.

Related: the general recovery guide (`docs/troubleshooting/recovery-guide.md`) covers `/swarm reset-session` and worktree reclamation; command reference lives in `docs/commands.md`.
