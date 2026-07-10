---
name: writing-tests
audience: swarm-plugin
description: Claude Code adapter for opencode-swarm test authoring rules. Use before creating or modifying tests in this repository.
---

# Writing Tests

Read and follow `../../../.opencode/skills/writing-tests/SKILL.md` as the canonical workflow.

## Claude Code Execution Notes

- Use the `.opencode` file as the source of truth for `bun:test`, mock
  isolation, temp path, per-file isolation, and regression-test falsifiability
  rules.
- When a repository-specific Claude workflow references this skill, load this
  adapter first, then apply the canonical `.opencode` guidance.
