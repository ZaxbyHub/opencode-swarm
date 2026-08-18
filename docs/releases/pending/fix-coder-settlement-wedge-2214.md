## Coder settlements no longer wedge at DISPATCHED (issue #2214)

### What changed

- **Dirty-tree coder dispatches are rejected up front.** A coder `Task` dispatch from a workspace with uncommitted or untracked files now fails at dispatch time with `CODER_SETTLEMENT_CLEAN_BASELINE_REQUIRED` (naming the offending files) instead of running the coder and then failing mutation attribution at settlement time. Previously such dispatches permanently wedged `.swarm/coder-settlements/{taskId}.json` at `"state": "DISPATCHED"`, blocking reviewer/test_engineer dispatch with `CODER_DISPATCH_IN_PROGRESS`, `CODER_SETTLEMENT_RECOVERY_UNCERTAIN`, and `TASK_WORKFLOW_STAGE_A_REQUIRED` with no recovery path. Commit or stash your changes before dispatching a coder — exact-task settlement cannot attribute coder mutations from a dirty launch baseline.
- **Abandoned settlements are now recoverable.** The `ABORTED` settlement state gained a real writer (`abortCoderSettlement`): a settlement whose launch baseline was structurally unattributable (no git history, or dirty at dispatch — the pre-fix wedge class) aborts instead of wedging. Legacy stuck DISPATCHED WALs self-heal: the next task-referencing `Task` dispatch, `check_gate_status`-style gated tool call, or `update_task_status` call after upgrading aborts them (recovery runs in the delegation gate's toolBefore and in `update_task_status`), after which the task can be repaired and a re-dispatch from a clean tree proceeds normally. With `hooks.delegation_gate: false` the self-heal runs only through `update_task_status`. Manually editing settlement JSON is not needed and still fails the WAL integrity check (`CODER_SETTLEMENT_WAL_UNREADABLE`) by design.
- **Non-git projects fail cleanly instead of wedging.** Coder dispatches in projects without git remain allowed, but their settlement now aborts at completion with a `CODER_SETTLEMENT_ABORTED` advisory instead of hanging the task at DISPATCHED forever.
- **Denied dispatches roll back.** When a fail-closed gate (full-auto, knowledge-enforce, skill-propagation) rejects a coder `Task` after the delegation gate already opened a settlement, the settlement WAL is rolled back to ABORTED so the task is not wedged despite the tool never running.
- **Knowledge-disabled configurations finalize delegations again.** The tool-args snapshot used by `tool.execute.after` is now taken unconditionally. With `knowledge.enabled=false`, architect Task dispatches previously had no stored args at toolAfter, silently skipping coder settlement finalization, Stage B advancement, and gate-evidence recording.
- **Settlement lifecycle is now observable.** `coder_settlement` events (`dispatched` / `settled` / `aborted`) are appended to `.swarm/events.jsonl`, so settlement progress can be diagnosed directly.

### Migration

No action required. Tasks previously stuck at DISPATCHED self-heal on first use after upgrading; re-dispatch coders from a clean (committed or stashed) workspace.

### Known caveats

- A workspace that is dirty at coder-dispatch time is now a hard dispatch error by design; attribution of same-path edits under a dirty baseline is provably impossible, and no bypass flag is offered.
- Foreground background-flagged coder dispatches (`background: true` while background subagents are disabled) from a dirty root are now rejected at the same dispatch-time guard. True background dispatches (background subagents enabled) are unchanged: they fail at claim time with existing recovery handling, as before.
