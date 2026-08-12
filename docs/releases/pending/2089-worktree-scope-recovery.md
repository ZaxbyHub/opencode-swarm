# Worktree coder scope and stale-lane recovery hardening

## What changed

- Worktree-isolated coder prompts now name their authoritative lane root and
  require FILE declarations, scope bindings, and edit/write paths to remain
  workspace-relative to that root. The same contract is retained in durable
  background-dispatch snapshots.
- Provisional worktree-owner markers now use a five-minute lease for the gap
  before the lane directory appears. Expired markers are released only when the
  exact Git-registered lane path is missing; live paths remain protected.
- Missing stale worktrees are recovered with metadata-only `git worktree prune`.
  Branch reconciliation stays in the existing safe provisioning path, which
  preserves branches with unmerged commits instead of force-deleting them.
- Learned directives now state that current system/repository/task authority
  wins and support `KNOWLEDGE_CONTRADICTED:<id> reason=...`, so stale guidance
  that conflicts with the active scope contract is recorded and rejected.

## Why

Issue #2089 showed that stale learned guidance and an orphaned provisional owner
could combine with a worktree lane whose root was invisible in the coder prompt:
the coder retried absolute project-root paths, scope authorization failed, and a
stale ownership marker could prevent safe lane recovery indefinitely.

## Migration

No configuration or state migration is required. Existing malformed ownership
records still fail closed, and existing worktree directories and unmerged lane
branches remain protected for manual recovery.

Closes: #2089
