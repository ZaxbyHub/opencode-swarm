---
name: pr-review-fix
description: Codex adapter for addressing pull request review feedback in opencode-swarm. Use when the user asks to fix PR review comments, requested changes, reviewer findings, CI-review notes, or a pasted review summary with low false-positive tolerance.
---

# PR Review Fix

Read `.opencode/skills/generated/pr-review-fix/SKILL.md` for the canonical workflow.

Codex-specific execution notes:

- Treat each review item as a claim to verify against the current branch or live PR head before editing.
- Use the GitHub app when available, or `gh`, to inspect unresolved review threads and PR metadata.
- For bot or app reviews, inspect both the review comment and any commits the bot pushed; compare each claim against branch history and current code before classifying it.
- Use `rg`, file reads, and tests to classify each item as confirmed, disproved, pre-existing, or unverified.
- Patch only confirmed gaps unless the user explicitly asks for speculative cleanup.
- Load `.agents/skills/commit-pr/SKILL.md` before committing, pushing, or updating the PR.

When review feedback involves tests, also load `$writing-tests`; when it involves runtime invariants, also load `$engineering-conventions`.
