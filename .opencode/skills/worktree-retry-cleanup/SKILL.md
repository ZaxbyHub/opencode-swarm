---
name: worktree-retry-cleanup
description: Protocol for cleaning parallel-coder worktree lanes before retry. Triggered before re-dispatching any task that already has a lane (completed, denied, cancelled, or failed).
---

# Worktree Retry Cleanup

## Trigger
Before re-dispatching a coder for a task that already has a lane (any prior dispatch status).

## Protocol
1. **Ownership check — do this FIRST, before any deletion.** Confirm the lane is not owned by another ACTIVE session: read `.swarm/session/state.json` and verify no other session's `delegationChains` reference `<session>/<task>`. If another active session owns it, STOP — surface the conflict and do not delete.
2. **Check for existing lane branch:** `git branch --list "swarm/lane/<session>/<task>"`
3. **If branch exists:**
   - Verify 0-commits-ahead: `git log --oneline HEAD..swarm/lane/<session>/<task>` — empty = safe
   - Delete: `git branch -d swarm/lane/<session>/<task>` (use `-D` only if `-d` fails AND the commits are confirmed unneeded)
   - Under full-auto, `-D` is deny-pattern-blocked — use `-d`
4. **Remove the per-lane worktree directory.** Target the SPECIFIC lane `.swarm-worktrees/<session>/<task>`, NOT the session parent (the parent holds sibling lanes). Prefer `git worktree remove .swarm-worktrees/<session>/<task>` — this is permitted because the path is under the `.swarm-worktrees/` base. A bare `rm -rf` / `Remove-Item -Recurse -Force` on `.swarm-worktrees/` is deny-pattern-blocked by the guardrail, so do not use it here.
5. **Prune:** `git worktree prune`
6. **Verify:** `git branch --list "swarm/lane/<session>/<task>"` returns empty
7. Only after cleanup, proceed to `declare_scope` + coder dispatch

## Root cause
The provisioning code should auto-clean after coder completion/denial/cancellation (tracked in issue #1746 item 1). This playbook is the temporary protocol.
