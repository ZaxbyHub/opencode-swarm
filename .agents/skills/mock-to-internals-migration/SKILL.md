---
name: mock-to-internals-migration
description: Codex adapter for migrating opencode-swarm tests away from Bun mock.module leakage toward _internals dependency-injection seams. Use when touching tests with mock.module, adding test seams, fixing Bun mock isolation failures, or updating source modules for injectable internals.
---

# Mock To Internals Migration

Read `.opencode/skills/generated/mock-to-internals-migration/SKILL.md` for the canonical migration protocol.

Also load:

1. `.agents/skills/writing-tests/SKILL.md`
2. `.agents/skills/engineering-conventions/SKILL.md` if the seam touches runtime-sensitive code

Codex-specific execution notes:

- Use `apply_patch` for source and test edits.
- Use focused per-file `bun --smol test <file> --timeout 30000` validation first.
- Restore any `_internals` overrides in `afterEach`.
- Prefer small seams that expose only the dependency under test.
