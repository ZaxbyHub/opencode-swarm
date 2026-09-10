# Task recovery runbook

A compact operator runbook for `/swarm diagnose` and `/swarm recover` (issue #2665): one shell-correct invocation per supported shell, the meaning of each recovery status category, and the boundary between deterministic repair and an external side effect that needs human reconciliation.

## Shell-correct invocations

Recovery runs through the host command path (the OpenCode TUI/GUI command line). When driving OpenCode headless, the shell you launch from changes how the `/swarm …` message argument must be written:

| Surface | Invocation | Why |
|---|---|---|
| Host command path (TUI/GUI) | `/swarm recover <task_id>` | Typed verbatim into the host — no shell rewrites it. |
| PowerShell (headless) | `opencode run --dir <project-dir> '/swarm recover <task_id>'` | Single quotes keep the `/swarm …` message argument literal in PowerShell parsing. |
| Git Bash / MSYS (headless) | `opencode run --dir <project-dir> "//swarm recover <task_id>"` | The leading slash is **doubled**: MSYS path conversion rewrites a single leading-slash argument to a path under the Git install root (`C:/Program Files/Git/swarm recover …`) before OpenCode ever sees it. |
| Shell-neutral CLI | `bunx opencode-swarm run recover <task_id> [--force]` | Identical in every shell; `--force` is an operator assertion that no dispatch is genuinely in flight. |

Known MSYS argument friction: do **not** set `MSYS_NO_PATHCONV=1` for the whole invocation. It silences the `/swarm` rewrite but also stops converting `--dir /c/...` style arguments, so every project-path resolution breaks. Doubling only the message argument's leading slash is the shell-correct form. There is deliberately no runtime shell detection — the forms above are documented, not sniffed.

`/swarm diagnose` follows the same rules (`'/swarm diagnose'` in PowerShell, `"//swarm diagnose"` in Git Bash, `bunx opencode-swarm run diagnose` on the CLI).

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
