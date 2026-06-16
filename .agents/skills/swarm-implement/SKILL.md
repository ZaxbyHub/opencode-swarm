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
- Before calling work complete, run a no-unwired/no-deferred gate: verify every
  new behavior is wired through config/registration/docs/tests/generated
  artifacts as applicable, no work was deferred or declared out of scope without
  explicit user instruction, and scope decisions were not made silently.
- For any worktree edit, also run the swarm final gate before declaring completion:
  - objective validation is recorded,
  - an independent implementation reviewer approved the actual latest diff,
  - a separate critic approved after reviewer approval,
  - every `NEEDS_REVISION` or `BLOCKED` item was fixed and re-reviewed,
  - no edit occurred after the latest reviewer/critic approval.
- Record reviewer and critic verdicts in durable task artifacts. For issue-tracer
  work, use `08b-implementation-review.md` and `09-final-critic.md`; otherwise
  use a task-local review artifact that names the verdicts, evidence reviewed,
  and responses to every blocker.
- Do not count explorer output, plan criticism, passing tests, or self-review as
  the final implementation reviewer gate when subagent delegation is available.

Do not invoke OpenCode `/swarm` commands from Codex unless the user explicitly asks to operate OpenCode Swarm itself.
