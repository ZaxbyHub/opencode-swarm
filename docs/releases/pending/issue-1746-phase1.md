# Worktree cleanup and skill-assertion pre-push check (issue #1746 Phase 1)

## What changed

Phase 1 of issue #1746 addresses two P0 friction points from long swarm sessions.

### FR-001 — Unconditional worktree cleanup on every coder dispatch outcome

Every coder dispatch now cleans up after itself — whether it succeeds, is denied by the orchestrator, or is cancelled mid-execution. No worktree directory, lane branch, or in-memory tracking entry is left behind.

- **FR-001a (cleanup unconditionally)**: On success, denial, or cancellation, the worktree, lane branch, and in-memory tracking are removed. A retry no longer collides with a prior run's leftover artifacts.
- **FR-001b (pre-provision collision check + ownership validation)**: Before dispatching a coder, the system checks whether a lane is already provisioned for this session and cleans it up first. Lanes belonging to other active sessions are never touched (ownership validated by session ID).
- **FR-001c (dirty-state preservation on denial/cancellation, fail-closed)**: When a dispatch is denied or cancelled and the worktree has uncommitted work, the system auto-commits the changes and tags the commit with a `swarm-collision-recovery/` tag before cleaning up. If the git operation fails, cleanup aborts entirely to protect the work — no artifact is silently discarded.

### FR-002 — Skill-content pre-push check

When a contributor edits a skill file or architect prompt, a pre-push check now flags any existing test that asserts exact wording from that file and would break with the new content. The check is integrated into the existing `scripts/drift-check.ts` CI workflow — no new CI pipeline is introduced. Results are available locally in under 5 seconds for a typical single-file diff.

## Migration steps

No migration required. Existing behavior is unchanged for cases not covered by the scenarios above.

## Key constraints

- FR-001c uses **fail-closed preservation**: if the git auto-commit/tag fails, cleanup is aborted entirely so no work is lost.
- FR-001b **detects stale lanes before re-provisioning** and **preserves cross-session lanes** via session-ID ownership validation.
- FR-002 **extends the existing drift-check.ts workflow** rather than introducing a new CI step.
