---
name: Copilot coding task
about: File a task you intend to assign to a Copilot/AI coding agent, with the publication contract pre-attached.
title: ""
labels: []
assignees: []
---

## Problem / goal

<!-- What is broken or needed? Be specific and self-contained. -->

## Acceptance criteria

<!-- Concrete, testable "done" conditions. Reference existing files/functions where possible. -->

## Reproduction / context

<!-- Steps, commands, logs, stack traces, environment. Issue clarity strongly predicts a good fix. -->

---

## Copilot publication contract

When assigned to this issue, an AI coding agent MUST use `.github/skills/commit-pr/SKILL.md`
(which routes to the single source of truth, `.claude/skills/commit-pr/SKILL.md`) before
committing, pushing, opening a PR, editing a PR body, marking a PR ready, or claiming CI is green.

The resulting PR must satisfy:

- **title**: `<type>(<scope>): <description>` (lowercase description, no trailing period)
- **first body line**: `Closes #<issue-number>`
- **body sections**: `## Summary`, `## Invariant audit`, `## Test plan`
- **release fragment**: `docs/releases/pending/<unique-slug>.md` for user-visible changes
- **validation evidence**: the exact commands run and their results under `## Test plan`
- **issue comment** after PR creation: PR link, what changed, how to use it, migration notes

The `pr-standards` CI check enforces the title/body/release-fragment contract; PRs that ignore it
cannot merge.
