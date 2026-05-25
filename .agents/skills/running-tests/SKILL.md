---
name: running-tests
description: Codex adapter for safely executing opencode-swarm tests. Use whenever Codex needs to run focused tests, per-file isolation loops, CI-equivalent validation, test-impact checks, or diagnose failing/truncated test output without stalling the session.
---

# Running Tests

Use this adapter when executing tests in `opencode-swarm`. For writing tests, load `$writing-tests` instead.

Read, in order:

1. `AGENTS.md`
2. `.opencode/skills/running-tests/SKILL.md`

Codex-specific execution notes:

- Use the available shell execution tool for `bun --smol test` and PowerShell/bash loops.
- Prefer `rg` and repo scripts to rediscover exact commands from source.
- Capture long output to a temp file when needed and report the important tail or failure lines.
- Do not use broad OpenCode `test_runner` scopes for repo validation.
- On Windows, if Bun reports `EPERM` after a forced dependency refresh, rerun the same focused command with approved/elevated access before treating it as a test failure.

Default rule: one source file or one explicit test file can be targeted narrowly; multiple files or directories should use shell loops or the documented tier commands.
