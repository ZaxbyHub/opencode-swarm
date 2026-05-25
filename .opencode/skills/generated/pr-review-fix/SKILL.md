---
name: pr-review-fix
description: >
  Legacy compatibility entry point for PR review feedback fixes. Use
  swarm-pr-feedback instead for new work; this shim exists so older references
  still route to the canonical feedback-closure workflow.
effort: medium
---

# PR Review Fix Compatibility Shim

Use `../../swarm-pr-feedback/SKILL.md` as the canonical workflow.

This legacy entry point must not grow an independent process. When invoked:

1. Load `../../swarm-pr-feedback/SKILL.md`.
2. Build the complete feedback ledger described there.
3. Verify each review item skeptically before editing.
4. Leave GitHub review-thread resolution to the user unless explicitly instructed.
5. Use the repository commit/PR workflow before pushing or updating the PR.

Do not follow older `pr-review-fix` behavior that batches comments without first
ingesting CI failures, conflicts, branch drift, and all review surfaces.
