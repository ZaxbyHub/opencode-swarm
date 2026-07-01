# Testing Guide

> **For LLM agents:** Load the `writing-tests` skill (`.opencode/skills/writing-tests/SKILL.md`) before writing or modifying any test file. It contains the full mock isolation rules, CI pipeline structure, and anti-patterns. For agent operational safety and the broader engineering invariants of this repo (especially the `test_runner` broad-scope restriction and the `_internals` DI-seam pattern for mock isolation), read [`AGENTS.md`](./AGENTS.md) at the repo root.

> **⚠️ Do NOT use the OpenCode `test_runner` tool to validate the full repo.** It is for targeted agent validation with explicit `files: [...]` or small targeted scopes. `scope: 'all'` requires `allow_full_suite: true` and is intended for opt-in CI mirrors only. Broad scopes can stall or kill OpenCode before the `MAX_SAFE_TEST_FILES = 50` guard in `src/tools/test-runner.ts` fires. For repo validation, use the shell commands below — per-file isolation loops match CI behavior. See [`AGENTS.md`](./AGENTS.md) invariant 6 for the full contract.

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

**Do not run `bun --smol test tests/unit/tools` or `tests/unit/hooks` as a single batch.** Mock modules leak across files in Bun's `--smol` mode, causing false failures. The CI uses per-file isolation loops for the 15 mock.module hook files (step 1a) and steps 4-6 (tools, services, state/agents), while other hook tests remain in batch groups (step 1b).

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

**Mock cleanup enforcement:** `scripts/check-mock-cleanup.sh` runs in CI (quality job) and enforces two checks:
1. All `mock.module` calls have `afterEach(mock.restore())` cleanup or file-scoped `mockClear`/`mockReset` pattern
2. All `mock.module('node:*', ...)` calls spread real exports (e.g., `...realFs`) to prevent test pollution

Run locally before pushing:
```bash
bash scripts/check-mock-cleanup.sh
```

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
| 1a | hooks (mock.module files — 15 files) | Per-file isolation (dedicated step) |
| 1b | hooks (remaining groups) | Per-file loop per group |
| 2 | cli | Batch |
| 3 | commands, config | Batch |
| 4 | tools | Per-file loop |
| 5 | services, build, quality, sast, sbom, scripts | Per-file loop |
| 6 | adversarial, agents, background, context, diff, evidence, git, helpers, knowledge, lang, output, parallel, plan, session, skills, types, utils | Per-file loop |

### Test File Size Limits

To prevent monolithic test files that cause mock isolation issues and slow CI:
- **Maximum 500 lines per test file** (enforced by convention, not CI)
- `delegation-gate.test.ts` was split into 45 focused files (FR-006 SC-006.1) — all under 500 lines
- When a test file exceeds 500 lines, split it by behavior/feature into focused files

### New Behavioral Test Files (Phase 3–4 — Issue #1231 Structural Debt)

Phase 3 files:

| File | Tests | Coverage |
|------|-------|----------|
| `tests/unit/commands/sync-plan.test.ts` | 10 | FR-007 (sync-plan command) |
| `tests/unit/agents/sme.test.ts` | 24 (75% parameterized) | FR-008 (SME delegation) |
| `tests/unit/parallel/lean-turbo-acquire-locks.test.ts` | 14 | FR-009 (Lean Turbo locking) |
| `tests/unit/parallel/lean-turbo-plan-lanes.test.ts` | 16 | FR-009 (lane planning) |
| `tests/unit/parallel/lean-turbo-review.test.ts` | 13 | FR-009 (Lean Turbo review) |
| `tests/unit/parallel/lean-turbo-runner-status.test.ts` | 18 | FR-009 (runner status) |
| `tests/unit/tools/generate-mutants.test.ts` | 11 | FR-009 (mutation testing) |
| `tests/unit/config/set-qa-gates.test.ts` | 19 | FR-009 (QA gate config) |
| `tests/unit/config/get-qa-gate-profile.test.ts` | 9 | FR-009 (QA gate profile) |

Phase 4 files (FR-010/011/012 — previously untested hooks):

| File | Tests | Coverage |
|------|-------|----------|
| `tests/unit/hooks/conflict-resolution.test.ts` | — | FR-010 (conflict-resolution hook) |
| `tests/unit/hooks/curator-types.test.ts` | — | FR-010 (curator types) |
| `tests/unit/hooks/curator.test.ts` | — | FR-010 (curator consolidated) |
| `tests/unit/hooks/delegate-ack-collector.test.ts` | — | FR-011 (delegate-ack-collector hook) |
| `tests/unit/hooks/delegate-directive-injection.test.ts` | — | FR-011 (delegate-directive-injection hook) |
| `tests/unit/hooks/knowledge-reinforcement.test.ts` | — | FR-011 (knowledge-reinforcement hook) |
| `tests/unit/hooks/normalize-tool-name.test.ts` | — | FR-011 (normalize-tool-name hook) |
| `tests/unit/hooks/phase-complete-directive-gate.test.ts` | — | FR-011 (phase-complete-directive-gate hook) |
| `tests/unit/hooks/phase-directives.test.ts` | — | FR-011 (phase-directives hook) |
| `tests/unit/hooks/semantic-diff-injection.test.ts` | — | FR-011 (semantic-diff-injection hook) |

Phase 4 also consolidated knowledge-curator tests with shared fixtures (`tests/unit/hooks/curator-test-fixtures.ts`) and completed the vitest→bun:test migration across all 11 directories (cli, services, session, evidence, commands, build, lang, scripts, config, knowledge, context-map, hooks, tools).

### Coverage Gate

CI enforces a minimum code coverage threshold (41.48%) on the merge queue. Coverage is measured using `bun test --coverage` with output configured in `bunfig.toml`:

```toml
# bunfig.toml
[test]
coverageReporter = ["lcov", "text"]
coverageDir = "./coverage"
```

The coverage gate runs in a dedicated `coverage` job (a required status check) but only on `merge_group` events (not on every PR for speed). It runs the full unit suite once with coverage in its own job, separate from the sharded `unit` job, so the long full-suite measurement does not stack onto a unit shard's timeout budget. To measure coverage locally:

```bash
bun test --coverage tests/unit/ --timeout 60000
```

The coverage report is output to `./coverage/` as `lcov.info` and text summary.

### Adversarial Tests

Adversarial tests (`tests/adversarial/`) verify security boundaries against crafted malicious inputs. They cover:

- **FR-003 / SC-003.1–SC-003.7**: Subprocess injection — command injection vectors via `shell.safeify`, bunSpawn routing, PATH traversal, null-byte injection, argument injection
- **FR-004 / SC-004.1–SC-004.4**: Guardrail bypass attempts — prompt injection, capability escalation, schema override, context capsule exfiltration
- **FR-005 / SC-005.1–SC-005.3**: Evidence spoofing — plan mutations, phase伪造, retrospective fabrication

Run adversarial tests with the same isolation rules as unit tests:

```bash
# Per-file loop (required — adversarial tests may mock global state)
for f in tests/adversarial/*.test.ts; do bun --smol test "$f" --timeout 30000; done
```

Adversarial tests use `_internals` DI seams for mocking (avoiding `mock.module` cross-file leakage):

- `src/hooks/knowledge-migrator.ts:_internals` — exposes `writeSentinel`, `mkdir`, `writeFile`, `existsSync`, `readFileSync`, `readFile` for evidence-spoofing tests
- `src/evidence/manager.ts:_internals` — exposes `validateEvidence` for evidence integrity tests

### Cross-Platform

- Use `path.join()`, never string concatenation with `/`
- Use `os.tmpdir()`, never hardcoded `/tmp`
- Mock `validateDirectory` from `path-security.ts` when tests use Windows temp paths
- On Windows, if `%USERPROFILE%` (or another ancestor of `%TEMP%`) already contains both `.swarm/` and a project indicator such as `.opencode/`, evidence-writing tests can fail the `.swarm` containment guard before they reach your temp project root. For per-file `tests/unit/tools/*.test.ts` publication evidence, either clear the parent `.swarm/` contamination first or run the temp-root setup from a directory tree that is outside that contaminated ancestor chain.

### Full Details

See `.opencode/skills/writing-tests/SKILL.md` for the complete guide including:
- All mock isolation rules and patterns
- File placement conventions
- Test quality standards (DO and DO NOT)
- Cross-platform process spawning rules
- Pre-submission checklist
