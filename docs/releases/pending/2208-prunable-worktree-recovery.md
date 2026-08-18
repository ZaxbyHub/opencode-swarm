# Worktree provisioning: recover `prunable` registrations instead of stalling

## What changed

When an opencode-swarm session is killed mid-task, the task's `git worktree` directory can be deleted while git's index still tracks the registration as `prunable`. Restarting the task used to fail in two ways (issue #2208):

- inside the 5-minute provisioning-lease window: `STANDARD_WORKTREE_OWNER_PROTECTED` (the pre-provision collision check classified the stale registration as an active lane, routing into the ownership inspector, which trusts the live lease unconditionally);
- after lease expiry: `Branch already exists and expected worktree is dirty` (`provisionWorktree` ran `isCleanWorktree` against the missing directory, and git failures are treated as dirty).

Both porcelain parsers now understand the `prunable` attribute:

- `preProvisionCollisionCheck` (`src/hooks/delegation-gate/worktree-isolation.ts`) skips `prunable` entries when scanning for lane collisions — a stale registration is not an active lane, so the protected-owner hard-stop is never reached for prunable lanes and recovery works inside the lease window. This is safe because `git worktree add` is atomic (a registration exists iff the worktree exists), so a provisioning-in-progress lane can never appear as prunable.
- `provisionWorktree` (`src/worktree/core.ts`) detects a `prunable` registration for the expected path or branch, runs `git worktree prune`, and re-enumerates before classifying — the leftover branch then reconciles through the existing stale-branch path (ahead-count check → `git branch -d` → re-add) and provisioning succeeds.

`locked` worktrees are unaffected (`git worktree prune` never removes them, and they never carry `prunable`).

Known bound (documented per review): the recovery keys on git's own `prunable` attribute — i.e. git has noticed the directory is gone. A registration whose directory was deleted by an external process in the instant before git has re-examined it is not yet marked `prunable` and still classifies as an active collision (fail-closed), which is the pre-existing behavior and the safe direction for a destructive-cleanup guard.

## Why

Aborted tasks required manual lock clearing and waiting out the lease before the worktree could be re-provisioned.

## Migration

No migration required.
