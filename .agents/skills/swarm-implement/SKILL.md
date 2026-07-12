---
name: swarm-implement
audience: swarm-plugin
description: Codex adapter for complex implementation work using the canonical opencode-swarm implementation workflow. Use for multi-file features, bug fixes, refactors, risky code changes, or tasks that benefit from exploration, scoped planning, implementation, review, and validation.
---

# Swarm Implement

Read and follow `../../../.opencode/skills/swarm-implement/SKILL.md` as the canonical workflow.

Codex-specific execution notes:

- Use `update_plan` for substantial multi-step work.
- Use the runtime's parallel-execution capability for independent repo reads and searches.
- Use `apply_patch` for manual edits.
- Use focused shell validation after each meaningful change.
- Bring in narrower skills as needed: `$engineering-conventions`,
  `$writing-tests`, `$running-tests`, `$qa-sweep`, or `$issue-tracer`.
- Record reviewer and critic verdicts in durable task artifacts. For
  issue-tracer work, use `08b-implementation-review.md` and
  `09-final-critic.md`; otherwise use a task-local review artifact that names
  verdicts, evidence reviewed, and responses to every blocker.
- Do not invoke OpenCode `/swarm` commands from Codex unless the user explicitly
  asks to operate OpenCode Swarm itself.
