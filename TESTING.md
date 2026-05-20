# Testing Guide

> **For LLM agents:** Load the `writing-tests` skill (`.opencode/skills/writing-tests/SKILL.md`) before writing or modifying any test file. It contains the full mock isolation rules, CI pipeline structure, and anti-patterns. For agent operational safety and the broader engineering invariants of this repo (especially the `test_runner` broad-scope restriction and the `_internals` DI-seam pattern for mock isolation), read [`AGENTS.md`](./AGENTS.md) at the repo root.

> **⚠️ Do NOT use the OpenCode `test_runner` tool to validate the full repo.** It is for targeted agent validation with explicit `files: [...]` or small targeted scopes. `scope: 'all'` requires `allow_full_suite: true` and is intended for opt-in CI mirrors only. Broad scopes can stall or kill OpenCode before the `MAX_SAFE_TEST_FILES = 50` (`src/tools/test-runner.ts:26`) guard fires. For repo validation, use the shell commands below — per-file isolation loops match CI behavior. See [`AGENTS.md`](./AGENTS.md) invariant 6 for the full contract.

## Quick Reference

### Framework

All tests use `bun:test`. No Jest, Vitest, or other frameworks.

```typescript
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
```

### Running Tests

```bash
# Single file (always safe)
bun --smol test tests/unit/tools/diff.test.ts --timeout 30000

# Per-file loop (required for tools, services, agents — prevents mock poisoning)
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done

# Batch run (safe only for directories without mock conflicts)
bun --smol test tests/unit/hooks --timeout 120000
bun --smol test tests/unit/cli --timeout 120000
```

**Do not run `bun --smol test tests/unit/tools` as a single batch.** Mock modules leak across files in Bun's `--smol` mode, causing false failures. The CI uses per-file isolation loops for steps 4-6 (tools, services, state/agents).

**Bun v1.3.13+:** The `--isolate` flag is available for local development to run each test file in a fresh global environment. However, CI currently uses `--smol` with per-file isolation loops, which achieves the same mock isolation goal. You may use `--isolate` locally, but the CI pipeline will continue using `--smol` with per-file loops for consistency.

### Mock Isolation

Bun's `--smol` mode shares module cache between test files. A `mock.module()` call replaces the module globally for all files in the same process.

**`mock.restore()` does NOT reliably restore `mock.module` mocks in Bun v1.3.11.** Three layers of defense are required.

**Always spread the real module when mocking Node built-ins:**

```typescript
import * as realChildProcess from 'node:child_process';
const mockExecFileSync = mock(() => '');
mock.module('node:child_process', () => ({
  ...realChildProcess,           // preserve ALL exports — mandatory
  execFileSync: mockExecFileSync, // override only what you need
}));
```

**Always add `afterEach(mock.restore())` for cross-module mocks.** Even though unreliable in Bun v1.3.11, it provides best-effort cleanup. **Exception — Windows EBUSY:** Test files that spawn async child processes (pre-check-batch suite) must NOT call `mock.restore()` on Windows. Child process handles hold directory locks and trigger `EBUSY` errors. Skip affected tests with `test.skipIf(process.platform === 'win32')`.

Intentionally skipped on Windows (async child process handles cause EBUSY):
- `tests/unit/tools/pre-check-batch.test.ts`
- `tests/unit/tools/pre-check-batch.adversarial.test.ts`
- `tests/unit/tools/pre-check-batch-cwd.test.ts`
- `tests/unit/tools/pre-check-batch-cwd.adversarial.test.ts`
- `tests/unit/tools/pre-check-batch-contextdir-adversarial.test.ts`
- `tests/unit/tools/pre-check-batch-sast-preexisting.test.ts`
- `tests/unit/tools/pre-check-batch-secretscan-evidence.test.ts`

**Use lazy binding in source code** so mocks can intercept:

```typescript
// Good — mockable
import * as child_process from 'node:child_process';
function run() { return child_process.execFileSync('git', ['status']); }

// Bad — binds at load time, mock can't intercept
import { execFileSync } from 'node:child_process';
```

### CI Pipeline Steps

| Step | Directories | Isolation |
|------|-------------|-----------|
| 1 | hooks (Linux/macOS only) | Batch per-group |
| 2 | cli | Batch |
| 3 | commands, config | Batch |
| 4 | tools | Per-file loop |
| 5 | services, build, quality, sast, sbom, scripts | Per-file loop |
| 6 | adversarial, agents, background, context, diff, evidence, git, helpers, knowledge, lang, output, parallel, plan, session, skills, types, utils | Per-file loop |

### Cross-Platform

- Use `path.join()`, never string concatenation with `/`
- Use `os.tmpdir()`, never hardcoded `/tmp`
- Mock `validateDirectory` from `path-security.ts` when tests use Windows temp paths

### Full Details

See `.opencode/skills/writing-tests/SKILL.md` for the complete guide including:
- All mock isolation rules and patterns
- File placement conventions
- Test quality standards (DO and DO NOT)
- Cross-platform process spawning rules
- Pre-submission checklist
