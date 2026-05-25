---
name: swarm-pr-feedback
description: >
  Codex adapter for closing known PR feedback in opencode-swarm. Use when asked
  to address pasted review feedback, GitHub review comments or threads,
  requested changes, CI/check failures, merge conflicts, stale PR branches, or
  follow-up work that must verify and close all known PR issues.
---

# Swarm PR Feedback

Read and follow `../../../.opencode/skills/swarm-pr-feedback/SKILL.md` as the
canonical workflow.

## Codex Execution Notes

- Use GitHub connector tools when available, or `gh`, to inspect PR metadata,
  review threads, comments, requested changes, checks, conflicts, and head SHA.
- Treat every feedback item as a claim until verified against source, tests,
  logs, or PR metadata.
- Use `rg`, focused file reads, and targeted tests to classify each item as
  `CONFIRMED`, `PARTIAL`, `DISPROVED`, `PRE_EXISTING`, or `NEEDS_USER_DECISION`.
- Use `apply_patch` for manual edits and keep patches scoped to confirmed root
  causes.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- Load `$writing-tests` when adding or modifying tests.
- Load `$engineering-conventions` when feedback touches plugin initialization,
  subprocesses, `.swarm/` containment, runtime portability, tool registration,
  plan durability, guardrails, or chat/system hooks.
- Load `$commit-pr` before committing, pushing, updating a PR body, marking ready,
  or closing out CI.

Final responses must include a closure ledger that maps every original feedback
item to `fixed`, `disproved`, `pre-existing`, or `needs user decision`.
