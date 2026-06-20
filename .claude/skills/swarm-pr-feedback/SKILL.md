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

- Check out the PR branch locally before verifying or fixing anything. Fetch the
  head ref if absent, confirm the working tree is clean, then verify against the
  PR branch rather than the base branch.
- Build the complete feedback ledger before editing: pasted feedback, GitHub
  comments/threads, requested changes, CI/check failures, merge conflicts,
  stale branch state, PR body claims, linked issues, commits, and any validated
  `swarm-pr-review` handoff artifact.
- Treat every feedback item as a claim until source evidence, tests, logs, or
  PR metadata prove or disprove it.
- Preserve original finding IDs and reviewer/critic provenance from review
  handoff artifacts.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- Use the repository commit/PR workflow before pushing or updating the PR.

Final output must include a closure ledger for every original feedback item,
including conflicts, stale branch state, obsolete CI, and generated-output drift
when they affected the PR.
