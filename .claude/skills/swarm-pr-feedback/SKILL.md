---
name: swarm-pr-feedback
description: >
  Claude Code adapter for closing known PR feedback. Use when addressing pasted
  review feedback, GitHub review comments or threads, requested changes,
  CI/check failures, merge conflicts, stale PR branches, or PR follow-up work
  that must verify every claim before fixing it. Supports multi-round bot
  reviews (bot posts a new review after every push) via the iterative pattern
  in the canonical skill.
---

# Swarm PR Feedback

Read and follow `../../../.opencode/skills/swarm-pr-feedback/SKILL.md` as the
canonical workflow.

## Claude Code Execution Notes

- Check out the PR branch locally before verifying or fixing anything: fetch the
  head ref if absent, confirm the working tree is clean (`git status --porcelain`),
  then check it out. Verification and fixes must run against the PR branch, not the
  base branch.
- **MCP push sync (remote execution environments):** When pushing via
  `mcp__github__push_files` instead of local `git push`, the local working tree is
  not updated by the push. After each MCP push, resync the local tree with
  `git fetch origin <branch> && git reset --hard origin/<branch>` before reading
  or editing files — otherwise reads and diffs will reflect the pre-push state.
- **Bot rate-limit re-trigger:** When a CI bot pauses automatic reviews due to
  iteration frequency (e.g., "I've paused automatic reviews — trigger with
  `@cubic-dev-ai review`"), post the trigger comment immediately after each push.
  Without the manual trigger the bot does not re-engage and the review cycle stalls
  invisibly.
- Start by collecting all feedback surfaces before editing: pasted feedback,
  GitHub review threads/comments, requested-changes reviews, CI/check failures,
  conflicts, branch drift, PR body claims, linked issues, and commits.
- Treat every item as a claim until source evidence, tests, logs, or PR metadata
  proves it.
- Cluster feedback by root cause before delegating fixes.
- Use reviewer or critic agents for high-risk, ambiguous, or cross-file items.
- Resolve GitHub review threads only when the user has explicitly instructed it.
  "Address any comments on the PR" and "resolve review threads" are explicit instructions.
  A general "fix the PR" or "update the PR" is not. When resolving is authorized, verify
  the fix is present in the current code before resolving — do not resolve a thread whose
  underlying issue has not been corrected.
- **Already-fixed thread closure:** When resolving is authorized and a thread's issue is
  already addressed in the current code (fixed in a prior commit): (1) read the current
  code at the cited file:line to confirm the fix is present, (2) reply to the thread's
  root comment citing the fixing commit SHA and what changed, (3) resolve the thread.
  Do not open a code-change path for already-fixed issues — only acknowledge and close.
  If a thread's issue is NOT yet fixed in code, treat it as a normal feedback item
  requiring a code change before resolution.
- Do not run a fresh broad PR review while closing known feedback. Inspect nearby
  code only to verify reachability, dependency, root cause, or regression risk.
- Use the repository commit/PR workflow before pushing or updating the PR.
- When `main` has a merge queue enabled, do not rebase or force-push only because
  `main` advanced — once checks/review are green, queue the PR and let the queue do
  final current-base validation. Still fix real merge conflicts and SHA-dependent
  review threads.
- **Local git server unavailable (remote execution fallback):** In Claude Code remote
  sessions (claude.ai/code), the local git server can become inaccessible mid-session
  (e.g., after checkout operations that leave the working tree empty). When `git fetch`,
  `git checkout`, or `git status` fail, use GitHub MCP tools instead:
  - Read PR branch files: `mcp__github__get_file_contents` with `ref` set to the PR
    head branch name or SHA
  - Read base branch files for conflict comparison: `mcp__github__get_file_contents`
    with `ref` set to the base branch name
  - Push merged/fixed content: `mcp__github__push_files` with full file content,
    commit message, and branch
  - Check mergeability: `mcp__github__pull_request_read` with `method: "get"` (inspect
    `mergeable_state`: `"clean"` = no conflicts and mergeable, `"behind"` = behind base (no conflicts, but merging may be blocked until updated), `"dirty"` = merge conflict)
  This MCP path is also preferred when conflict resolution is a clear superset case
  (one branch already contains all of the other's changes) — it avoids a three-way
  merge entirely.

Final output must include a closure ledger for every original feedback item.
Include operational blockers such as merge conflicts, stale branch state,
obsolete older-head CI, and generated-output drift as explicit ledger items when
they affected the PR.
