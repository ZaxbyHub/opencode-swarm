---
name: swarm-pr-feedback
description: >
  Claude Code adapter for closing known PR feedback. Use when addressing pasted
  review feedback, GitHub review comments or threads, requested changes,
  CI/check failures, merge conflicts, stale PR branches, or PR follow-up work
  that must verify every claim before fixing it.
---

# Swarm PR Feedback

Read and follow `../../../.opencode/skills/swarm-pr-feedback/SKILL.md` as the
canonical workflow.

## Claude Code Execution Notes

- Start by collecting all feedback surfaces before editing: pasted feedback,
  GitHub review threads/comments, requested-changes reviews, CI/check failures,
  conflicts, branch drift, PR body claims, linked issues, and commits.
- Treat every item as a claim until source evidence, tests, logs, or PR metadata
  proves it.
- Cluster feedback by root cause before delegating fixes.
- Use reviewer or critic agents for high-risk, ambiguous, or cross-file items.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- Do not run a fresh broad PR review while closing known feedback. Inspect nearby
  code only to verify reachability, dependency, root cause, or regression risk.
- Use the repository commit/PR workflow before pushing or updating the PR.
- When `main` has a merge queue enabled, do not rebase or force-push only because
  `main` advanced — once checks/review are green, queue the PR and let the queue do
  final current-base validation. Still fix real merge conflicts and SHA-dependent
  review threads.

Final output must include a closure ledger for every original feedback item.
Include operational blockers such as merge conflicts, stale branch state,
obsolete older-head CI, and generated-output drift as explicit ledger items when
they affected the PR.
