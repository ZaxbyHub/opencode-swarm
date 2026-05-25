---
name: qa-sweep
description: Codex adapter for independent QA review of opencode-swarm changes. Use after implementation or debugging when the user asks for a QA sweep, regression check, review pass, quality gate, or confidence check before publishing.
---

# QA Sweep

Read `.claude/skills/qa-sweep/SKILL.md` for the source protocol, then translate it to Codex tools.

Codex-specific execution notes:

- Review the diff first with `git status --short` and `git diff --stat`.
- Inspect changed files directly; do not rely only on summaries.
- Run focused validation commands that match the changed surface.
- For code-review output, lead with findings by severity and file/line references.
- For implementation QA, report residual risks and tests run.

Also load `$running-tests` when executing tests and `$engineering-conventions` when invariant-sensitive areas changed.
