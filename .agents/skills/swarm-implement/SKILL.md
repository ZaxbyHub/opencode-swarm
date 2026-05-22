---
name: swarm-implement
description: Codex adapter for complex implementation work using a swarm-like workflow. Use for multi-file features, bug fixes, refactors, risky code changes, or tasks that benefit from exploration, scoped planning, implementation, review, and validation.
---

# Swarm Implement

Read `.claude/skills/swarm-implement/SKILL.md` for the source workflow, then apply Codex-native tooling.

Codex-specific execution notes:

- Use `update_plan` for substantial multi-step work.
- Use `multi_tool_use.parallel` for independent repo reads and searches.
- Use `apply_patch` for manual edits.
- Use focused shell validation after each meaningful change.
- Bring in narrower skills as needed: `$engineering-conventions`, `$writing-tests`, `$running-tests`, `$qa-sweep`, or `$issue-tracer`.

Do not invoke OpenCode `/swarm` commands from Codex unless the user explicitly asks to operate OpenCode Swarm itself.
