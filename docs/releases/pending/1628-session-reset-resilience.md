# Session-reset resilience: idempotent worktree provisioning + settled-task re-open guard

## What changed

### FR-004 — Idempotent worktree provisioning on session resume/reset

When a session resets mid-phase and resumes (or when a new session picks up an existing plan), stale worktrees and branches from the interrupted session are now handled safely:

- **`src/worktree/core.ts` — `provisionWorktree`**: Before creating a worktree, checks whether the branch already exists. If it does, enumerates ALL registered worktrees (not just the expected path) to detect whether the branch is checked out anywhere. If the branch is active in another worktree → returns an error (active collision). If the branch exists but is NOT registered anywhere → adopts the existing branch into the new worktree path (stale worktree recovery). This prevents `git worktree add -f` from silently creating a second checkout of an active branch.
- **`.opencode/skills/resume/SKILL.md` + `.claude` mirror**: Resume protocol now explicitly calls out stale worktree/branch reconciliation as the first step before resuming, using `cleanupOrphanedBranches`/`startupOrphanRecovery` helpers.
- **`src/commands/reset-session.ts`**: Reset now wipes `.swarm-worktrees/` and runs `cleanupOrphanedBranches` to remove orphan `swarm-lane/*` branches from the previous session.
- **`src/hooks/delegation-gate/worktree-isolation.ts`**: Resume and standard provisioning paths now also call `cleanupOrphanedBranches` at startup, deleting stale `swarm-lane/*` branches for inactive sessions (preserving the current session's lane state) — not just metadata pruning, but full branch cleanup.

### FR-005 — Settled-task re-open guard

`update_task_status` (and the automated delegation path via `advanceTaskStateAndPersist`) can no longer silently re-open a settled task (`completed` / `blocked` / `closed`) back to `in_progress`. An explicit `force: true` option exists for manual repair scenarios.

- **`src/plan/manager.ts`** — `updateTaskStatus` now checks current task state before allowing `in_progress` transitions. If the task is settled and `options.force` is not `true`, the update is refused and the current plan state is returned unchanged.
- **`src/tools/update-task-status.ts`** — The tool accepts a `force?: boolean` argument (defaults to `false`). When a settled task would be re-opened without force, returns an error with guidance: "Use force:true only for manual repair."

## Why

FR-004: A session that resets mid-phase and resumes would collide with stale worktrees/branches from the interrupted run, causing provisioning failures or git state corruption. The idempotent approach (adopt stale / error on active collision) makes resume and reset safe to run at any point in a phase.

FR-005: The automated delegation path could re-open a task that was already marked `completed` or `blocked` when a session restarted mid-phase, silently overwriting completed work with a fresh `in_progress` state. The guard makes this class of silent data loss impossible without an explicit override.

## Migration steps

None for existing users. The settled-task guard is transparent — it only blocks an impossible operation, never changes behavior for legitimate flows.

## Tests

- `worktree-core.test.ts`: idempotent provisioning tests covering stale adopt, active collision detection, and orphan recovery paths
- `update-task-status-settled-guard.test.ts`: guard behavior with and without `force`
- `reset-session-worktree-cleanup.test.ts`: cleanup of orphaned worktrees and branches on reset

Closes: #1628
