---
name: engineering-conventions
description: Codex adapter for opencode-swarm engineering invariants. Use before modifying plugin initialization, subprocesses, runtime portability, .swarm containment, plan durability, test_runner behavior, test-writing patterns, session/global state, guardrails/retry semantics, chat/system hooks, tool registration, release/cache hygiene, or related architecture.
---

# Engineering Conventions

Use this adapter before any change that can touch a repository invariant.

Read, in order:

1. `AGENTS.md`
2. `docs/engineering-invariants.md`
3. `.opencode/skills/engineering-conventions/SKILL.md`

If editing agent prompt strings or escaped template text, also skim `.claude/skills/engineering-conventions/SKILL.md` because it carries prompt-string pitfalls.

Codex-specific execution notes:

- Use `apply_patch` for manual edits.
- Use the available shell execution tool for `rg`, `git`, build, smoke, and test commands.
- Use `multi_tool_use.parallel` for independent file reads and searches.
- Keep changes scoped and produce concrete invariant evidence for every touched invariant.

The source of truth is always `AGENTS.md`. If an imported skill conflicts with it, `AGENTS.md` wins.
