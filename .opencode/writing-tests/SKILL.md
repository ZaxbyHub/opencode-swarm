---
name: writing-tests
description: >
  Apply when writing tests, modifying test files, fixing test failures, debugging CI failures,
  adding test coverage, creating adversarial tests, or reviewing any file under tests/.
  Also apply when implementing features or fixes that require corresponding test changes.
  Enforces bun:test framework rules, mock isolation, cross-platform compatibility (Linux,
  macOS, Windows), and CI pipeline awareness. Load this skill before touching any test file.
effort: medium
---

# Writing Tests for opencode-swarm

## Framework: bun:test Only

All test files MUST import from `bun:test`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
```

Bun provides a vitest compatibility layer (`vi.mock`, `vi.fn`, `vi.spyOn`) that works on Linux and macOS. However, `vi.mock()` has critical isolation bugs in Bun when multiple test directories run in the same process. Prefer `bun:test` native APIs:

| vitest API | bun:test equivalent | Notes |
|-----------|-------------------|-------|
| `vi.fn()` | `mock(() => ...)` | Import `mock` from `bun:test` |
| `vi.spyOn(obj, method)` | `spyOn(obj, method)` | Import `spyOn` from `bun:test` |
| `vi.mock('module', factory)` | `mock.module('module', factory)` | Import `mock` from `bun:test` |
| `vi.restoreAllMocks()` | `mock.restore()` | Call in `afterEach` |

## Mock Isolation Rules

**CRITICAL: Module-level mocks leak across test files within the same Bun process.**

The CI pipeline runs test directories in groups. All files in a group share one Bun process and one module cache. A `vi.mock()` or `mock.module()` call in file A replaces the module for file B if they run in the same group.

### Rules

1. **Never mock a module that another test file in the same CI group imports directly.** If `tests/unit/cli/run-dispatch.test.ts` mocks `../../src/commands/agents.js`, then `tests/unit/commands/agents.test.ts` (in the same group) will get the mock instead of the real module.

2. **If you must use module-level mocks, isolate the test in its own CI step** or use dependency injection instead of module replacement.

3. **Never create circular mock imports.** This pattern deadlocks Bun:
```typescript
// BROKEN — imports from the module it's about to mock
import { realFn } from '../../src/module.js';
vi.mock('../../src/module.js', () => ({
  realFn: (...args) => realFn(...args),  // circular!
  otherFn: vi.fn(),
}));
```
Instead, inline the function logic or extract the real functions into a separate utility module.

4. **Prefer constructor/parameter injection over module mocking.** The swarm's hook factories (`createScopeGuardHook`, `createDelegationLedgerHook`, etc.) accept injected dependencies — test them by passing mock callbacks, not by replacing modules.

## CI Pipeline Structure

The CI runs on three platforms (ubuntu, macos, windows). Tests are split into sequential steps within each platform's job.

**Per-file isolation:** Each test file runs in its own Bun process via `for f in dir/*.test.ts; do bun --smol test "$f"; done`. This prevents module cache poisoning between files within the same step.

**Cascade termination:** Each step uses `exit $failed` — the first failing step terminates the entire platform's job. This means failures in later steps are hidden until earlier steps pass. When fixing Windows issues, expect to peel back layers: fixing Step 4 may reveal a failure in Step 5 that was previously hidden.

```
Step 1: hooks - guardrails            (Linux/macOS only, skipped on Windows)
Step 2: hooks - knowledge             (Linux/macOS only, skipped on Windows)
Step 3: hooks - system-enhancer       (Linux/macOS only, skipped on Windows)
Step 4: hooks - delegation + others   (Linux/macOS only, skipped on Windows)
Step 5: commands + config             (all platforms)
Step 6: cli                           (all platforms)
Step 7: tools                         (all platforms)
Step 8: services + build + quality + sast + sbom + scripts  (all platforms)
Step 9: state + agents + knowledge + evidence + plan + misc (all platforms)
```

When writing a test, know which step your file will run in. Do not assume isolation from other files in the same step.

**Job timeout: 15 minutes.** A single hanging test will kill the entire platform's test run.

## File Placement

### Convention

| Test type | Location | When to use |
|-----------|----------|-------------|
| Unit tests for `src/hooks/*.ts` | `tests/unit/hooks/` | Testing hook factories and hook behavior |
| Unit tests for `src/tools/*.ts` | `tests/unit/tools/` | Testing tool execute functions |
| Unit tests for `src/commands/*.ts` | `tests/unit/commands/` | Testing CLI command handlers |
| Unit tests for `src/config/*.ts` | `tests/unit/config/` | Testing schema validation, config loading |
| Unit tests for `src/agents/*.ts` | `tests/unit/agents/` | Testing agent prompt generation, factory logic |
| Colocated tests | `src/**/*.test.ts` | Integration-style tests tightly coupled to the source module |
| Integration tests | `tests/integration/` | Cross-module workflows, plugin initialization |
| Security tests | `tests/security/` | Adversarial input handling, injection resistance |
| Smoke tests | `tests/smoke/` | Built package validation |

### Naming

- Base test: `<module>.test.ts`
- Adversarial variant: `<module>.adversarial.test.ts`

Only create an adversarial variant if it tests **distinct attack vectors** not covered by the base test. Do not duplicate base test assertions with different inputs — that's redundancy, not security coverage.

### Regression tests (review-surfaced bugs)

When fixing a bug surfaced by code review, swarm review, or post-merge audit, **always add a regression test** with the following shape so the test's purpose survives future cleanup:

```typescript
describe('<feature> — regression: <one-line description> (F#)', () => {
  it('<exact behavior the bug violated>', () => {
    // Previous code did <bad thing>: e.g. the regex `/^\.\/+/` only stripped
    // a single leading `./`, so `././util.ts` survived as `./util.ts`.
    expect(normalizeGraphPath('././util.ts')).toBe('util.ts');
  });
});
```

Rules:
- The describe label includes the original finding ID (e.g. `F8`, `F9`, `F1.1`) so future readers can map back to the review.
- The leading comment in the body explains the **prior buggy behavior** in concrete terms — what the code did before, not what it does now.
- One regression test per finding. Do not pile unrelated assertions into a single regression block.

Examples in-tree: `tests/unit/graph/graph-query.test.ts` (`normalizeGraphPath — regression (F8)`, `getBlastRadius — regression: depthReached (F9)`), `tests/unit/graph/import-extractor.test.ts` (`paren-preceded strings (F1)`, `member-expression require/import (F1.1)`).

## Test Quality Standards

### DO

- Test real behavior: call the actual function with real inputs, assert on real outputs.
- Test error paths: what happens with `null`, `undefined`, empty string, oversized input?
- Use temp directories (`fs.mkdtemp`) for file I/O tests. Clean up in `afterEach`.
- Assert on specific values, not just truthiness: `expect(result.status).toBe('pending')` not `expect(result).toBeTruthy()`.

### DO NOT

- **Do not test type definitions.** `expect(event.type === 'foo').toBe(true)` tests TypeScript, not your code.
- **Do not test framework behavior.** "Zod schema parses valid input" tests Zod, not your schema.
- **Do not test test utilities.** If it only exists to support other tests, it doesn't need its own test.
- **Do not mock everything.** If every dependency is mocked, you're testing the mock setup. Prefer real dependencies for pure functions and only mock I/O boundaries (filesystem, network, timers).
- **Do not hardcode version numbers.** Version bumps are automated — a test asserting `version === '6.31.3'` breaks on every release.
- **Do not use `sleep` or `setTimeout` for synchronization.** Use explicit signals, resolved promises, or `Bun.sleep()` with tight bounds.
- **Do not spawn `cat /dev/zero`, `yes`, or other infinite-output commands.** Use `sleep 30` for "blocking command" tests.

## Cross-Entry Invariants (config maps)

When you modify any entry of a "map of agents/tools/roles" in `src/config/constants.ts` (`AGENT_TOOL_MAP`, `DEFAULT_MODELS`, `QA_AGENTS`, `PIPELINE_AGENTS`, etc.), there are tests that assert **parity across sibling entries**, not just shape of one entry.

Known parity assertions:

| Test | Invariant |
|---|---|
| `tests/unit/config/critic-registration.test.ts:67` | `AGENT_TOOL_MAP.critic_sounding_board.length === AGENT_TOOL_MAP.critic.length` |
| `tests/unit/config/agent-tool-map.test.ts:26` | `AGENT_TOOL_MAP.architect.length` is strictly greater than every other agent's |
| `tests/unit/config/agent-tool-map.test.ts:34` | every subagent's tool list `<= 20` entries |
| `tests/unit/config/constants.test.ts:48` | `ALL_SUBAGENT_NAMES.length === 13` |
| `tests/unit/config/constants.test.ts:137` | `Object.keys(DEFAULT_MODELS).length === 14` |

Workflow when adding a tool to a single agent:
1. Add the entry.
2. Run `bun --smol test tests/unit/config --timeout 60000` **before pushing**.
3. If a parity test fails, decide: mirror the change to sibling agents (most common — see this PR's `repo_map` mirrored to `critic_sounding_board` + `critic_drift_verifier`), or update the invariant test if the design intent has actually changed.
4. To inspect runtime shape quickly: `bun -e "import { AGENT_TOOL_MAP } from './src/config/constants.ts'; for (const [k,v] of Object.entries(AGENT_TOOL_MAP)) console.log(k, v.length);"`

Do **not** push a constants change to CI without running the config test directory locally — these failures cascade through the per-OS unit jobs and waste minutes per push.

## Cross-Platform Requirements

All tests must pass on Linux, macOS, and Windows unless explicitly gated.

### Skipping tests on specific platforms

Use the `skipIf` chaining pattern:
```typescript
// Skip on Windows only
test.skipIf(process.platform === 'win32')('test name', async () => { ... });

// Skip on non-Linux (use when test relies on Linux-specific behavior)
test.skipIf(process.platform !== 'linux')('test name', async () => { ... });

// Skip entire describe block
describe.skipIf(process.platform === 'win32')('group name', () => { ... });
```

### Temp directories and path handling
- Use `path.join()` or `path.resolve()`, never string concatenation with `/`.
- Temp directories: use `os.tmpdir()`, never hardcoded `/tmp`.
- **CRITICAL: Wrap `mkdtempSync` with `realpathSync` when using `process.chdir`:**
  ```typescript
  // WRONG — on macOS, /tmp is a symlink to /private/tmp.
  // mkdtempSync returns /tmp/... but process.cwd() resolves to /private/tmp/...
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  process.chdir(tempDir);
  // process.cwd() !== tempDir on macOS!

  // CORRECT — resolve symlinks first
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'test-')),
  );
  process.chdir(tempDir);
  ```
- File comparisons: normalize paths before comparing (`path.resolve(a) === path.resolve(b)`).

### Permissions (`fs.chmodSync`)
- `chmodSync` is a **no-op for directories** on Windows and unreliable for files.
- Tests that rely on chmod to simulate permission errors should guard with platform checks:
  ```typescript
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o000);
    // ... test permission error behavior ...
    fs.chmodSync(filePath, 0o644); // restore
  } else {
    // On Windows, skip or use a mock to throw EPERM
  }
  ```
- If the test asserts that the tool handles permission errors **gracefully** (returns success despite write failure), the test may pass on Windows even without chmod — the write just succeeds. Verify this before adding guards.

### Symlinks
- `fs.symlinkSync` requires **administrator or developer mode** on Windows.
- Use a runtime capability check:
  ```typescript
  let canCreateSymlinks = false;
  try {
    const testLink = path.join(tempDir, '.symlink-test');
    fs.symlinkSync(tempDir, testLink);
    fs.unlinkSync(testLink);
    canCreateSymlinks = true;
  } catch {}

  test.skipIf(!canCreateSymlinks)('symlink test', async () => { ... });
  ```

### Process spawning
- Use `.cmd` extension on Windows for npm/bun binaries: `process.platform === 'win32' ? 'bun.cmd' : 'bun'`.
- Use array-form `spawn`/`spawnSync`, never shell string commands.
- **`npx` in empty temp dirs hangs on Windows.** If a test creates a temp directory with a `package.json` (for framework detection) and then calls a tool that spawns `npx vitest run` or similar, the spawn will hang until the test timeout fires. Skip these tests on non-Linux:
  ```typescript
  // Flaky on macOS/Windows: spawns vitest in temp dir without node_modules
  test.skipIf(process.platform !== 'linux')(
    'test that triggers process execution',
    async () => { ... },
    15000,
  );
  ```

### Timestamps
- Avoid comparing strings that embed `new Date().toISOString()`. Two sequential calls can span a millisecond boundary, especially on Windows CI. Strip or normalize volatile timestamps before comparison:
  ```typescript
  const stripTimestamp = (s: string) =>
    s.replace(/Updated: \d{4}-\d{2}-\d{2}T[\d:.]+Z/, 'Updated: <FROZEN>');
  expect(stripTimestamp(output1)).toBe(stripTimestamp(output2));
  ```

## Running Tests

```bash
# Full suite (all platforms)
bun test

# Single file
bun test tests/unit/hooks/scope-guard.test.ts

# Single directory
bun --smol test tests/unit/hooks --timeout 30000

# CI-equivalent run (per-file isolation, matches actual CI behavior)
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 120000; done

# Quick directory run (faster but may have cross-file cache pollution)
bun --smol test tests/unit/cli --timeout 120000
bun --smol test tests/unit/commands tests/unit/config --timeout 120000
```

The `--smol` flag reduces Bun's memory footprint. Use it when running large directories (50+ files).

The `--timeout 120000` flag sets per-test timeout to 120 seconds. Individual tests should complete in under 5 seconds. If a test needs more than 10 seconds, it's doing too much — split it or mock the slow dependency.

**Note:** CI runs each file in its own Bun process (`for f in dir/*.test.ts; do bun --smol test "$f"; done`). Running an entire directory at once (`bun --smol test tests/unit/tools/`) can mask cache-poisoning issues that only appear in CI. When debugging CI failures, test files individually.

## Debugging CI failures

When CI reports a `unit (ubuntu-latest|macos-latest|windows-latest)` failure:

1. **Identify the actual failing test from the job log first.** Do not assume it's a pre-existing failure based on a local repro of a different test. Open the failing job's URL (`https://github.com/<owner>/<repo>/actions/runs/<run-id>/job/<job-id>`) and find the `<file>:<line>` in the Bun output. WebFetch can scrape this if the `gh` CLI isn't available.
2. **Reproduce that exact file locally** with the per-file CI command:
   ```bash
   bun --smol test tests/unit/<dir>/<file>.test.ts --timeout 30000
   ```
3. **Then check if the same failure reproduces on `main`.** If yes, document as pre-existing in the PR description and continue with your branch's work; do not silently inherit the failure.
4. **For `package-check` failures:** `package-check` validates the npm tarball (`npm pack` + tarball contents). A failure here is a source/build/package-manifest problem, not generated-file drift. `dist/` is generated and NOT committed — do not stage it; run `bun run build` locally only when you need the bundle. There is no longer a committed-dist drift check.
5. **For matrix-OS-only failures:** check `process.platform` guards, `mkdtempSync` realpath wrapping, chmod guards, symlink capability checks, and `npx`-spawn skips (sections above).

## Before Submitting

1. Run the tests for your changed files: `bun test path/to/your.test.ts`
2. Run the full CI group your tests belong to (see pipeline structure above)
3. Verify no `process.cwd()` usage — use the `directory` parameter from `createSwarmTool` or hook constructor
4. Verify no hardcoded paths (`/tmp/...`, `C:\...`) — use `os.tmpdir()` + `path.join()`
5. Verify mocks are restored in `afterEach` if using `spyOn` or `mock.module`
6. Verify `mkdtempSync` is wrapped with `realpathSync` if you use `process.chdir` on the result
7. Verify `chmodSync` calls are guarded with `process.platform !== 'win32'`
8. Verify symlink creation is guarded or uses a `canCreateSymlinks` capability check
9. Verify no `new Date().toISOString()` in equality assertions — strip volatile timestamps
10. Verify tests that spawn `npx`/`vitest`/`jest` in temp dirs are skipped on non-Linux
