---
name: guardrail-patterns
description: Codex adapter for opencode-swarm destructive-command guardrail changes. Use before modifying src/hooks/guardrails.ts, checkDestructiveCommand, dcNormalizeCommand, shell-wrapper parsing, .swarm destructive-command blocking, or guardrails unit/adversarial tests.
---

# Guardrail Patterns

Read, in order:

1. `AGENTS.md`
2. `.agents/skills/engineering-conventions/SKILL.md`
3. `.agents/skills/writing-tests/SKILL.md` if tests are touched
4. `.opencode/skills/generated/guardrail-patterns/SKILL.md`

Codex-specific execution notes:

- Use `rg` to locate the current guardrail section numbers before editing; line numbers in generated skills can drift.
- Preserve wrapper-unwrapping, normalization, and per-segment evaluation order unless the task is specifically to change it.
- Add or update adversarial tests for bypass surfaces, argument-order permutations, Windows shell forms, and `.swarm` path variants.
- Run focused guardrail tests after the change and report exact commands.
