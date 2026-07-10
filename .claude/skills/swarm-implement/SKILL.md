---
name: swarm-implement
audience: swarm-plugin
description: Claude Code adapter for the canonical opencode-swarm implementation workflow. Use for feature work, bug fixes, refactors, and multi-file changes that need exploration, implementation, review, and validation.
disable-model-invocation: true
---

# Swarm Implement

Read and follow `../../../.opencode/skills/swarm-implement/SKILL.md` as the canonical workflow.

## Claude Code Execution Notes

- Use parallel subagents for disjoint exploration and independent review.
- Use objective validation commands appropriate to the repository.
- For changed-work tasks, record reviewer and critic approvals in durable task
  artifacts before final synthesis.
- Do not count explorer output, passing tests, or self-review as the final
  implementation reviewer gate when subagent delegation is available.
