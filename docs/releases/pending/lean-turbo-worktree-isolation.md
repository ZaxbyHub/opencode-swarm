### feat(turbo): git worktree isolation for parallel Lean Turbo lanes

**What changed**

Implements complete git worktree isolation for Lean Turbo parallel lane execution, enabling each coder lane to work in its own isolated git worktree with independent branches. Merges completed lane work back to the primary tree with conflict handling, dirty-tree recovery, and Windows filesystem safety.

- **New `src/turbo/lean/worktree.ts`** — worktree lifecycle (create, provision, remove) with:
  - `assertCleanWorkingTree()` — verifies HEAD is clean before provisioning
  - `provisionWorktreeForLane()` — creates worktree + branch per lane with Windows path budget (250 chars, auto-shorten to `swwt` prefix)
  - `checkPathBudget()` — respects `core.longpaths` git config (skips budget when enabled)
  - `cleanUntrackedFiles()` — safe cleanup with dry-run safety gate and `SAFE_CLEAN_PATTERNS` allowlist
  - `_internals` DI seam for test isolation

- **New `src/turbo/lean/merge-back.ts`** — merge-back strategies with conflict handling:
  - `mergeToPrimary()` — merge, rebase, or cherry-pick with full `merge-base` range (not tip-only)
  - `attemptMergeBackFromDirty()` — auto-commit + clean + merge for dirty worktrees
  - `cleanupOrphanedBranches()` / `startupOrphanRecovery()` — stale branch/worktree cleanup
  - `_internals` DI seam for test isolation

- **Runner integration** (`src/turbo/lean/runner.ts`):
  - `assertCleanWorkingTree` guard in `runPhase` — dirty tree degrades all lanes to shared directory
  - Explicit lane failure on worktree provision failure (no silent degradation)
  - `MergeBackFailureInfo` type with `mergeBackFailure` on `LaneResult` — surfaces conflicts/errors to callers
  - `postMergeCleanup` (branch delete + prune) runs AFTER `removeWorktree` — git refuses branch deletion on active worktrees
  - `_sequentialWorktreeCleanup` with correct merge → remove → cleanup order
  - Transient retry for Windows file-lock failures (EBUSY, EPERM, ENOENT, ETIMEDOUT) — 4 attempts, 2s delay
  - `_internals` DI seam for `assertCleanWorkingTree` and `bunSpawn`

- **Config schema** (`src/config/schema.ts`, `src/config/constants.ts`):
  - `worktree_dir` and `merge_strategy` options for Lean Turbo config
  - `DEFAULT_LEAN_TURBO_CONFIG` defaults

- **Guardrails** (`src/hooks/guardrails.ts`): blocks `git worktree remove --force`

- **State** (`src/turbo/lean/state.ts`): `worktreePath`, `branchName`, `_failureCleanupPending` on `LeanTurboLane`

- **Tool response** (`src/tools/lean-turbo-run-phase.ts`): `mergeBackFailures` propagated through `LeanTurboRunPhaseResult`

**Why**

Parallel Lean Turbo lanes sharing a single directory cause file conflicts, race conditions, and merge headaches. Worktree isolation gives each lane its own filesystem sandbox while preserving the ability to merge results back.

**Migration**

No migration required. Worktree isolation is active when Lean Turbo is enabled. New config options:
- `lean_turbo.worktree_dir` — override worktree parent directory (default: `<project>/.swarm-worktrees`)
- `lean_turbo.merge_strategy` — `"merge"` (default), `"rebase"`, or `"cherry-pick"`

**Known caveats**

- `cleanUntrackedFiles` uses a fail-open pattern: if the dry-run safety gate fails, the clean proceeds (acceptable for ephemeral worktrees)
- Sequential worktree cleanup is O(N) with potential 2s retry delays per lane on Windows
- Cherry-pick tip-only fallback applies only to unrelated histories (no common ancestor)

**Tests**: 282 dedicated tests across 9 files + 445 existing lean turbo tests.
