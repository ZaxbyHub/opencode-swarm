# /swarm recover + reset-session settlement recovery: no permanent CODER_DISPATCH_IN_PROGRESS wedge

Issue: #2268

## What changed

- New `/swarm recover [task_id] [--force]` command (human-only) settles stale coder-settlement WALs in `.swarm/coder-settlements/` — the wedge class where a dispatch's completion never arrived (host killed mid-dispatch, cancelled Task, or the pre-#2214 gate-denial path users hit on ≤ 7.141.1) and every retry was refused with `CODER_DISPATCH_IN_PROGRESS` / `CODER_SETTLEMENT_IN_PROGRESS` while `update_task_status` and `/swarm close` were paused by the same guard. Safe mode recovers settlements whose owning process is gone; `--force` additionally releases ownership keys still held by the current process (operator assertion that nothing is genuinely in flight — a still-running dispatch's late completion then reports `CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT`, which is safe to ignore). Settlements owned by another live OpenCode process are reported and never interrupted.
- `/swarm reset-session` now recovers stale coder settlements (with ownership release) as part of clearing session state, reporting per-task outcomes — previously it cleared in-memory session state but left the durable WAL and in-process ownership key wedged, which is exactly what made the issue reporter's session unfinishable.
- The dispatch-denial rollback in the `tool.execute.before` chain (`src/index.ts`) no longer skips settlement rollback for throws from the advisory tail after the fail-closed region: any `toolBefore` throw for a Task call now rolls a begun settlement back to `ABORTED`. The old guard contradicted its own adjacent comment ("steps below … can still throw and reject the call"); the catch block only runs on throw, so the widened trigger cannot affect successful dispatches.
- Wedge error texts now name the real remediation instead of an action with no invoker: "run `/swarm recover <taskId>` (or `/swarm reset-session`)… do not remove the WAL by hand" (previously: "run coder-settlement recovery for this task" — an internal function with no user-facing surface).
- `/swarm diagnose` gains a "Coder Settlements" health check: enumerates settlement WALs, reports state and owner-process liveness per task, and flags non-terminal settlements with the exact remediation. Warn-level by design so a genuinely in-flight dispatch never fails the check.
- `coder_settlement` lifecycle audit events gain a `recovered` action (with `forced` / `accepted` extras), recorded for every recovery and forced ownership release.
- `docs/commands.md` and `docs/troubleshooting/recovery-guide.md` §11 document the new command, the wedge, and why hand-editing settlement WALs is harmful.

## Why

Issue #2268 reported the plugin as unusable: a 2-task hello-world run wedged permanently because a denied coder dispatch left a `DISPATCHED` settlement WAL that no user-reachable action could clear — the error text advised an action that did not exist, and `/swarm reset-session` did not touch the settlement state. On current main the reporter's exact denial path is already fixed (#2214/#2098), but the same wedge remained reachable when a dispatch's completion hook never fires in a still-running host process, and there was still no user-facing recovery command. This PR closes both: every advised action is now wired, and the two natural escape hatches (`/swarm recover`, `/swarm reset-session`) actually clear the wedge.

## Known caveats

- `--force` releasing an ownership key for a genuinely in-flight dispatch means that dispatch's late completion fails settlement with `CODER_SETTLEMENT_IDEMPOTENCY_CONFLICT`; the durable state is already recovered at that point and the conflict is safe to ignore (stated in the command output and docs). This is why the command is human-only — agents keep the safe self-heal path via `update_task_status`.
- `/swarm close` still surfaces `CODER_DISPATCH_IN_PROGRESS` (rather than recovering past it) when a wedged settlement guards a task it is closing; `/swarm recover` or `/swarm reset-session` unwedge first. Changing close's loop semantics is intentionally out of scope.
