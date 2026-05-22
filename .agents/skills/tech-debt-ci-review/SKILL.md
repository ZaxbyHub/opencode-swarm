---
name: tech-debt-ci-review
description: Codex adapter for deep technical-debt and CI-stability audits. Use when asked to find test theater, flaky tests, missing or mis-scoped tests, brittle CI/toolchain behavior, structural debt blocking green PRs, or a remediation order for opencode-swarm.
---

# Tech Debt CI Review

Read `.claude/skills/tech-debt-ci-review/SKILL.md` for the canonical audit structure.

Codex-specific execution notes:

- Start from actual CI/workflow files, test scripts, recent failures, and current repo state.
- Use shell commands and `rg` to gather evidence; avoid broad `test_runner` scopes.
- Prioritize findings that can cause false green, false red, flaky CI, or blocked release flow.
- Produce findings with file/line references, impact, evidence, and a remediation order.

Load `$running-tests` for validation command selection and `$engineering-conventions` when findings touch repo invariants.
