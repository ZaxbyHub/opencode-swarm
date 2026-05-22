---
name: writing-tests
description: Codex adapter for opencode-swarm test authoring rules. Use before creating or modifying any test file in this repository, especially bun:test files, mock.module usage, _internals seams, temp directories, cross-platform tests, or CI-sensitive test structure.
---

# Writing Tests

Use this Codex-facing adapter before touching tests in `opencode-swarm`.

Read, in order:

1. `AGENTS.md`
2. `.opencode/skills/writing-tests/SKILL.md`

If the task also touches architecture, plugin initialization, subprocesses, tool registration, plan durability, `.swarm` storage, runtime portability, session/global state, guardrails/retry, chat/system hooks, or release/cache behavior, also load `.agents/skills/engineering-conventions/SKILL.md`.

Codex-specific execution notes:

- Use `apply_patch` for manual test/source edits.
- Use the available shell execution tool for `bun --smol test`, per-file loops, `rg`, and validation commands.
- Prefer shell test commands for repo validation. Do not use broad OpenCode `test_runner` scopes.
- Preserve unrelated user changes in the worktree.

Carry forward the source skill's core rules: `bun:test` only, dependency injection or `_internals` over `mock.module` where possible, real module spreading when mocking Node built-ins, `os.tmpdir()` plus `path.join(...)` for temp paths, and per-file isolation for mock-heavy directories.
