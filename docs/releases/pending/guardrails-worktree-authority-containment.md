# Guardrails: allow file authority within linked git worktrees

## Summary

- When executing agent sessions inside a Git worktree or inspecting files across worktrees of the same repository, file authority checks could incorrectly fail with `AUTHORITY_ROOT_ESCAPE` (`target resolves outside the working directory`).
- Root cause: `checkFileAuthorityWithRules` assumed all valid file paths must be strictly contained within `dir` (`cwd`). In multi-worktree workflows, worktrees of the same repository live in sibling directories outside `dir`.
- Fix: `checkFileAuthorityWithRules` now discovers linked worktrees via `git worktree list --porcelain` (cached in LRU) and treats files located within any valid linked worktree of the repository as workspace-contained.

## Changes

- Adds `getLinkedGitWorktrees(dir)` with LRU cache and timeout.
- Updates `checkFileAuthorityWithRules` to check linked worktrees before raising `AUTHORITY_ROOT_ESCAPE`.
- Normalizes path matching and scope verification relative to the matched worktree root.
- Adds comprehensive unit test coverage in `tests/unit/hooks/guardrails-worktree-authority.test.ts`.
