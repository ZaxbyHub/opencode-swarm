---
name: worktree-retry-cleanup
description: Protocol for cleaning parallel-coder worktree lanes before retry. Triggered before re-dispatching any task that already has a lane (completed, denied, cancelled, or failed).
---

# Worktree Retry Cleanup

## Trigger
Before re-dispatching a coder for a task that already has a lane (any prior dispatch status).

## Protocol
1. **Check for existing lane branch:** `git branch --list "swarm/lane/<architect-session>/<task-id>"`
2. **If branch exists:**
   - Verify 0-commits-ahead: `git log --oneline HEAD..swarm/lane/<session>/<task>` — empty = safe
   - Delete: `git branch -d swarm/lane/<session>/<task>` (use `-D` only if `-d` fails AND commits confirmed unneeded)
   - Under full-auto, `-D` is deny-pattern-blocked — use `-d`
3. **Check for worktree directory:** if `.swarm-worktrees/<architect-session>` exists, remove it (`Remove-Item -Recurse -Force` / `rm -rf`)
4. **Prune:** `git worktree prune`
5. **Verify:** `git branch --list "swarm/lane/<session>/<task>"` returns empty
6. Only after cleanup, proceed to `declare_scope` + coder dispatch

## Ownership validation
Before deleting, verify the worktree is not owned by another ACTIVE session. Check `.swarm/session/state.json` for concurrent sessions. If another session owns it, DO NOT delete — surface the conflict.

## Root cause
The provisioning code should auto-clean after coder completion/denial/cancellation (tracked in issue #1746 item 1). This playbook is the temporary protocol.
