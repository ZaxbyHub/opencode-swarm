---
name: commit-pr
description: >
  Mandatory publication protocol for the GitHub Copilot coding agent and custom
  Copilot agents in opencode-swarm. Load when assigned to an issue or when
  committing, pushing, opening/updating/readying a PR, writing release notes, or
  closing out remote CI. Routes to the single canonical commit-pr source of truth.
---

# Commit PR (GitHub Copilot adapter)

This repository has exactly **one** publication workflow, and it is mandatory.

This file is a discovery shim so the GitHub Copilot agent can find the workflow
under a `.github/skills` path. It is **not** the source of truth and intentionally
duplicates none of the contract. The canonical, authoritative protocol is
[`../../../.claude/skills/commit-pr/SKILL.md`](../../../.claude/skills/commit-pr/SKILL.md).

Read and follow, in order:

1. [`../../../AGENTS.md`](../../../AGENTS.md)
2. [`../../../docs/engineering-invariants.md`](../../../docs/engineering-invariants.md)
3. [`../../../.claude/skills/commit-pr/SKILL.md`](../../../.claude/skills/commit-pr/SKILL.md) — **single source of truth**
4. [`../../../.agents/skills/commit-pr/SKILL.md`](../../../.agents/skills/commit-pr/SKILL.md) — Codex/Copilot execution adapter

If instructions ever conflict, precedence is: `AGENTS.md` → `docs/engineering-invariants.md`
→ `.claude/skills/commit-pr/SKILL.md` → adapters → this file.

Do not commit, push, run `gh pr create`, `gh pr edit`, or `gh pr ready`, edit a PR
body, mark a PR ready, or claim CI/merge readiness until the canonical `commit-pr`
checklist is satisfied.

The required PR title, PR body sections (`## Summary`, `## Invariant audit`,
`## Test plan`, plus `Closes #<issue-number>` as the first line *when the PR resolves
an issue*), invariant audit, release fragment, validation suite, issue comment,
draft/ready behavior, and CI closeout rules all come from
[`../../../.claude/skills/commit-pr/SKILL.md`](../../../.claude/skills/commit-pr/SKILL.md).
The `pr-standards` CI check and the `pr-publication-gate` hook enforce this contract;
do not work around them.
