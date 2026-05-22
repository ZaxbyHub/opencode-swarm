---
name: writing-tests
description: >
  Guidelines for writing, organizing, and maintaining tests in the opencode-swarm repository.
  Covers framework rules (bun:test), mock isolation, CI pipeline structure, file placement,
  and anti-patterns that break cross-platform CI. Load this skill before writing or modifying
  any test file.
---

# Writing Tests for opencode-swarm

> **⚠️ Do NOT use the OpenCode `test_runner` tool to validate the full repo.** It is for targeted agent validation with explicit `files: [...]` or small targeted scopes. `scope: 'all'` is reserved for CI / maintainer environments and is unavailable in agent sessions — never attempt it; use the per-file shell loops. Broad scopes can stall or kill OpenCode before the `MAX_SAFE_TEST_FILES = 50` (`src/tools/test-runner.ts:26`) guard fires. For repo validation, use the shell commands in this file — per-file isolation loops match CI behavior. See [`AGENTS.md`](../../../AGENTS.md) invariant 6 for the full contract.

## ⛔ STOP — Read Before Running Any Tests

**`test_runner` scope safety — one rule, no exceptions:**

| Scope | Files param | Safe? |
|-------|------------|-------|
| `'convention'` | single source file | ✅ Safe |
| `'convention'` | **multiple source files** | ❌ **Rejected** — guard fires (`scope_exceeded`) before fan-out; use shell loop |
| `'convention'` | direct test file paths | ✅ Safe — exempt from source-file limit |
| `'graph'` | single file | ✅ Safe |
| `'graph'` | **multiple files** | ❌ **Rejected** (`scope_exceeded`) — guard fires before import-graph traversal |
| `'impact'` | multiple files | ❌ **Rejected** (`scope_exceeded`) — same reason |
| `'all'` | any | ❌ **Never in agent context** |

**If you need to run tests across multiple source files: use a per-file shell loop, not `test_runner`.**

**Truncated output recovery:** When `bun test` output exceeds the bash tool buffer it is saved to a file whose ID (`tool_abc123...`) cannot be retrieved via `retrieve_summary` (which only accepts `S1`, `S2` format). Workaround — pipe to a temp file instead:
```powershell
# PowerShell (Windows)
bun --smol test tests/unit/agents --timeout 60000 | Out-File "$env:TEMP\test_out.txt"; Get-Content "$env:TEMP\test_out.txt" | Select-Object -Last 30
```
```bash
# bash (Linux/macOS)
bun --smol test tests/unit/agents --timeout 60000 2>&1 | tee /tmp/test_out.txt | tail -30
```

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

Bun's `--smol` mode shares the module cache between test files in the same worker process. A `mock.module()` call in file A replaces the module globally — file B gets the mock instead of the real module. This caused ~959 failures before per-file isolation was added (#330).

**Additional critical limitation (Bun v1.3.11):** `mock.restore()` does NOT reliably restore `mock.module` mocks. Cross-module mocks can persist across test boundaries even after `afterEach(mock.restore())` is called. Three layers of defense are required.

### Rules

1. **Spread the real module when mocking.** Only override the specific export you need:
```typescript
import * as realChildProcess from 'node:child_process';
const mockExecFileSync = mock(() => '');
mock.module('node:child_process', () => ({
  ...realChildProcess,          // preserve all other exports
  execFileSync: mockExecFileSync, // override only what you test
}));
```
This prevents tests from accidentally nullifying exports that other code depends on. **This is mandatory for Node built-ins** (`node:fs`, `node:fs/promises`, `node:child_process`, etc.) because other code imports the full module — returning a partial mock without spreading real exports breaks unrelated imports.

2. **Use lazy binding in source code.** Import the namespace, call methods at invocation time:
```typescript
// GOOD — mockable via mock.module
import * as child_process from 'node:child_process';
function run() { return child_process.execFileSync('git', ['status']); }

// BAD — binds at module load, mock.module can't intercept
import { execFileSync } from 'node:child_process';
```

3. **Always add `afterEach(mock.restore())` for cross-module mocks.** Even though it is unreliable in Bun v1.3.11, it provides best-effort cleanup and reduces the window of cross-file contamination. Without it, the mock persists until the process exits:
```typescript
import { afterEach, mock } from 'bun:test';

afterEach(() => {
  mock.restore();
});
```

**CRITICAL: When using `mockImplementation()` on a `mock()` function, call `mockReset()` in `afterEach`.** `mock.restore()` only restores `mock.module` state — it does NOT reset `mockImplementation` on individual `mock()` functions. Without `mockReset()`, the implementation set in one test leaks into the next test's active window:
```typescript
const mockFn = mock(() => 'default');

beforeEach(() => {
  mockFn.mockClear();  // Clear call history before each test
});

afterEach(() => {
  mockFn.mockReset();  // Clear call history and any mockImplementation set during the test
});
```
**Exception — Windows EBUSY:** Test files that spawn async child processes (e.g. `pre-check-batch` tests) must **NOT** call `mock.restore()` on Windows. Child process handles can hold directory locks, and `mock.restore()` triggers cleanup that causes `EBUSY` errors. These files must use `describe.skipIf(process.platform === 'win32')` or `test.skipIf(process.platform === 'win32')` for affected tests.

Intentionally skipped on Windows (async child process handles cause EBUSY):
- `tests/unit/tools/pre-check-batch-sast-preexisting.test.ts`
- `tests/unit/tools/pre-check-batch.adversarial.test.ts`
- `tests/unit/tools/pre-check-batch-cwd.test.ts`
- `tests/unit/tools/pre-check-batch-cwd.adversarial.test.ts`
- `tests/unit/tools/pre-check-batch-contextdir-adversarial.test.ts`
- `tests/unit/tools/pre-check-batch-secretscan-evidence.test.ts`
- `tests/unit/tools/pre-check-batch.test.ts`

4. **Never create circular mock imports.** This pattern deadlocks Bun:
```typescript
// BROKEN — imports from the module it's about to mock
import { realFn } from '../../src/module.js';
vi.mock('../../src/module.js', () => ({
  realFn: (...args) => realFn(...args),  // circular!
  otherFn: vi.fn(),
}));
```
Instead, inline the function logic or extract the real functions into a separate utility module.

5. **Prefer constructor/parameter injection over module mocking.** The swarm's hook factories (`createScopeGuardHook`, `createDelegationLedgerHook`, etc.) accept injected dependencies — test them by passing mock callbacks, not by replacing modules.

6. **Mock `validateDirectory` when testing with Windows temp paths.** The `path-security.ts` validator rejects Windows absolute paths (`C:\...`). If your test uses `os.tmpdir()` and passes that path to a function that calls `validateDirectory`, mock it:
```typescript
mock.module('../../../src/utils/path-security', () => ({
  validateDirectory: () => {},
  validateSwarmPath: (p: string) => p,
}));
```

## Two-Tier Mock Convention

The codebase uses a two-tier strategy for mock isolation:

### Tier 1: _internals DI Seams (Within-Module)

For mocking functions within the same module, source files export an `_internals` object that wraps key functions. Tests can replace individual functions without using `mock.module`:

```typescript
// In source file (src/services/my-service.ts)
import { spawnSync } from 'node:child_process';

type SpawnSyncFn = typeof spawnSync;  // Use typeof alias, NOT type import

export const _internals: {
  helperFn: typeof helperFn;
  spawnSync: SpawnSyncFn;  // ← expose for test injection
} = {
  helperFn,
  spawnSync,
};

export function mainFn() {
  return _internals.helperFn();
}
```

```typescript
// In test file
import { _internals, mainFn } from '../../../src/services/my-service';

test('mainFn uses mocked helper', () => {
  const original = _internals.helperFn;
  _internals.helperFn = mock(() => 'mocked');
  // ... test ...
  _internals.helperFn = original; // restore
});
```

**Benefits:**
- No process-global mock pollution
- Type-safe
- Fast (no module re-parsing)
- Works in batch test runs without isolation

### Tier 2: mock.module (Cross-Module)

When mocking dependencies from other modules (especially Node built-ins), use `mock.module` with proper cleanup:

```typescript
import * as realFs from 'node:fs/promises';

mock.module('node:fs/promises', () => ({
  ...realFs,  // MUST spread real exports
  readFile: mock(() => Promise.resolve('mocked')),
}));

afterEach(() => mock.restore());
```

**Critical rules for cross-module mocks:**
1. **Always spread real exports** for Node built-ins — other code depends on exports you don't mock
2. **Always add `afterEach(mock.restore())`** — provides best-effort cleanup
3. **Run in per-file isolation** — CI runs each file in its own process (`for f in *.test.ts; do bun --smol test "$f"; done`)

### Choosing Between Tiers

| Scenario | Pattern | Example |
|----------|---------|---------|
| Mocking a function in the same module you're testing | `_internals` seam | `src/state.ts` `_internals.loadSnapshot` |
| Mocking a Node built-in (fs, child_process, etc.) | `mock.module` + spread real | `mock.module('node:fs/promises', () => ({ ...realFs, readFile: mockFn }))` |
| Mocking another application module | `mock.module` + cleanup | `mock.module('../../../src/utils/logger', ...)` + `afterEach(mock.restore())` |
| File-scoped mock (applies to all tests in file) | `mock.module` at top level + `mockReset()` in `beforeEach` | Preflight tests with `mockLoadPlan.mockReset()` |

**Migrating from `mock.module` to `_internals`:** See the `mock-to-internals-migration` generated skill for the step-by-step protocol.

## mock.module() Export Completeness

When using `mock.module()` (or `vi.mock()`) with Bun's test runner, the mock factory **MUST provide stubs for ALL named exports** of the target module — not just the ones your test calls. Bun validates the export set at dynamic-import time and throws `SyntaxError: Export named 'X' not found` if any export is missing.

### Why this matters

Transitive imports may reference exports your test never calls directly. For example, if your test mocks `config/schema.js` and only uses `stripKnownSwarmPrefix`, but a transitive dependency imports `PluginConfigSchema` from the same module, the mock MUST include `PluginConfigSchema` as a stub — even though your test never calls it.

When the source module gains new exports (e.g., a PR adds 50 new Zod schemas to `config/schema.ts`), ALL existing `mock.module()` calls targeting that module must be updated — even if the new exports are irrelevant to your test.

### How to verify completeness

Before finalizing a test that uses `mock.module()`:

1. List all runtime exports of the target module (type-only exports are erased at compile time and need no stub):
   ```bash
   grep -E "^export (const|function|async function|class) " src/path/to/module.ts
   ```
   **Note:** Do NOT include `type` or `interface` exports — Bun erases these at compile time and they need no runtime stub.
2. Ensure every export name has an entry in your `mock.module()` factory.
3. Stubs can be minimal:
   - Functions: `() => null` or `async () => {}`
   - Zod schemas: use a comprehensive stub that supports common methods:
     ```typescript
     const zodStub = {
       parse: (v: unknown) => v,
       safeParse: (v: unknown) => ({ success: true as const, data: v }),
       parseAsync: async (v: unknown) => v,
     };
     ```
   - Constants: appropriate zero values (`''`, `0`, `null`, `[]`, `{}`)

### Verification pattern

```typescript
// ✅ CORRECT — all exports provided, test uses only the first one
mock.module('../../../src/config/schema.js', () => ({
  // The one export your test actually uses
  stripKnownSwarmPrefix: mockStripFn,
  // Stubs for transitive import resolution (never called in test)
  PluginConfigSchema: zodStub,
  ScoringConfigSchema: zodStub,
  isKnownCanonicalRole: () => false,
  // ... all other runtime exports as stubs
}));

// ❌ WRONG — missing exports cause SyntaxError at module-load time
mock.module('../../../src/config/schema.js', () => ({
  stripKnownSwarmPrefix: mockStripFn,
  // Missing: PluginConfigSchema, ScoringConfigSchema, etc.
  // → "SyntaxError: Export named 'PluginConfigSchema' not found"
}));
```

### What IS and IS NOT test theater

Adding stubs for ESM resolution is NOT test theater — it's a Bun runtime requirement. The distinction:

| Pattern | Test theater? | Why |
|---------|--------------|-----|
| Adding `PluginConfigSchema: zodStub` so the module loads | **No** | Required for ESM resolution; stub is never called |
| Stubbing `validateDirectory` to return `true` then asserting "validation works" | **Yes** | The stub bypasses the logic you should be testing |
| Using `zodStub` in assertions: `expect(zodStub.parse(input)).toBe(input)` | **Yes** | Testing the stub, not the real code |
| Adding stubs for ALL 50 Zod schemas in config/schema.ts | **No** | All are required for transitive import resolution |

The stubs exist solely to satisfy the module loader. Test assertions must verify behavior through the real-mocked functions (the ones your test actually calls), not through the stubs.

### Files Intentionally Using File-Scoped Mocks

Some test files use top-level `mock.module` that must persist across all tests in the file. These files use `mockReset()`/`mockClear()` in `beforeEach` instead of `mock.restore()` in `afterEach`:

- `src/__tests__/preflight-phase.test.ts` — mocks `plan/manager` and `preflight-service`

## CI Pipeline Structure

The CI runs on three platforms (ubuntu, macos, windows). Tests are split into sequential steps within each platform's job.

```
Step 1: hooks (Linux/macOS only, skipped on Windows) — batch per-group
Step 2: cli — batch
Step 3: commands + config — batch
Step 4: tools — per-file isolation loop
Step 5: services + build + quality + sast + sbom + scripts — per-file isolation loop
Step 6: state + agents + knowledge + evidence + plan + misc — per-file isolation loop
```

**Steps 4-6 use per-file isolation:** each `.test.ts` file runs in its own `bun --smol` process to prevent `mock.module()` cache poisoning (#330). Steps 1-3 run files in batch (one process per step) because they have fewer mock conflicts.

When writing a test, know which step your file will run in. In batch steps, do not assume isolation from other files in the same step.

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

Examples in-tree: `tests/unit/graph/graph-query.test.ts`, `tests/unit/graph/import-extractor.test.ts`, `tests/unit/graph/graph-store.test.ts`.

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
3. If a parity test fails, decide: mirror the change to sibling agents, or update the invariant test if the design intent has actually changed.
4. To inspect runtime shape quickly: `bun -e "import { AGENT_TOOL_MAP } from './src/config/constants.ts'; for (const [k,v] of Object.entries(AGENT_TOOL_MAP)) console.log(k, v.length);"`

## Debugging CI failures

When CI reports a `unit (ubuntu|macos|windows)` failure:

1. **Identify the actual failing test from the job log first.** Do not assume it's a pre-existing failure based on a local repro of a different test. Open the failing job's URL and find the `<file>:<line>` in the Bun output. WebFetch can scrape this if the `gh` CLI isn't available.
2. **Reproduce that exact file locally:** `bun --smol test tests/unit/<dir>/<file>.test.ts --timeout 30000`.
3. **Then check if the same failure reproduces on `main`.** If yes, document as pre-existing in the PR description and continue with your branch's work; do not silently inherit the failure.
4. **For dist-check failures:** any change under `src/` that the bundler picks up requires `bun run build` + commit of `dist/` in the same PR. The job compares committed `dist/` against a fresh build.

## Test Quality Standards

### DO

- Test real behavior: call the actual function with real inputs, assert on real outputs.
- Test error paths: what happens with `null`, `undefined`, empty string, oversized input?
- Use temp directories (`fs.mkdtemp`) for file I/O tests. Clean up in `afterEach`.
- **Stray `.swarm` directories**: Tests that create `.swarm/` directories MUST use `os.tmpdir()` + `path.join()` and clean up in `afterEach`. A stray `.swarm` at the drive root (e.g. `C:\.swarm`) blocks evidence writes, `write_retro`, `pre_check_batch`, and `sast_scan` for the entire project. The detection logic walks parent directories looking for `.swarm` and finds the wrong one.
- Assert on specific values, not just truthiness: `expect(result.status).toBe('pending')` not `expect(result).toBeTruthy()`.

### DO NOT

- **Do not test type definitions.** `expect(event.type === 'foo').toBe(true)` tests TypeScript, not your code.
- **Do not test framework behavior.** "Zod schema parses valid input" tests Zod, not your schema.
- **Do not test test utilities.** If it only exists to support other tests, it doesn't need its own test.
- **Do not mock everything.** If every dependency is mocked, you're testing the mock setup. Prefer real dependencies for pure functions and only mock I/O boundaries (filesystem, network, timers).
- **Do not hardcode version numbers.** Version bumps are automated — a test asserting `version === '6.31.3'` breaks on every release.
- **Do not use `sleep` or `setTimeout` for synchronization.** Use explicit signals, resolved promises, or `Bun.sleep()` with tight bounds.
- **Do not spawn `cat /dev/zero`, `yes`, or other infinite-output commands.** Use `sleep 30` for "blocking command" tests.
- **Do not use weak assertions in adversarial tests.** `expect(result !== undefined).toBe(true)` and `expect(result).toBeDefined()` only verify "didn't crash" — they do NOT verify the system's actual response to the attack vector. Always assert specific behavior: `expect(result).toBeNull()`, `expect(result.status).toBe('invalid_schema')`, `expect(result.message).toContain('ERROR')`. Weak assertions hide regressions in graceful-degradation logic.

## Cross-Platform Requirements

All tests must pass on Linux, macOS, and Windows unless explicitly gated with:
```typescript
const isWindows = process.platform === 'win32';
if (isWindows) test.skip('reason', () => {});
```

### Path handling
- Use `path.join()` or `path.resolve()`, never string concatenation with `/`.
- Temp directories: use `os.tmpdir()`, not hardcoded `/tmp`.
- File comparisons: normalize paths before comparing (`path.resolve(a) === path.resolve(b)`).

### Process spawning
- Use `.cmd` extension on Windows for npm/bun binaries: `process.platform === 'win32' ? 'bun.cmd' : 'bun'`.
- Use array-form `spawn`/`spawnSync`, never shell string commands.

## Running Tests

### bash (Linux / macOS)

```bash
# Single file
bun test tests/unit/hooks/scope-guard.test.ts

# Batch directory (safe for dirs without mock conflicts)
bun --smol test tests/unit/hooks --timeout 30000

# Per-file loop (required for tools/services/agents — prevents mock poisoning)
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done

# CI-equivalent run for batch steps
bun --smol test tests/unit/cli --timeout 120000
bun --smol test tests/unit/commands tests/unit/config --timeout 120000
```

### PowerShell (Windows)

```powershell
# Single file
bun test tests/unit/hooks/scope-guard.test.ts

# Batch directory (safe for dirs without mock conflicts)
bun --smol test tests/unit/hooks --timeout 30000

# Per-file loop (required for tools/services/agents — prevents mock poisoning)
Get-ChildItem tests/unit/tools/*.test.ts | ForEach-Object { bun --smol test $_.FullName --timeout 30000 }

# CI-equivalent run for batch steps
bun --smol test tests/unit/cli --timeout 120000
bun --smol test tests/unit/commands tests/unit/config --timeout 120000

# Capture output to file (avoids truncation when output is large)
bun --smol test tests/unit/agents --timeout 60000 | Out-File "$env:TEMP\test_out.txt"; Get-Content "$env:TEMP\test_out.txt" | Select-Object -Last 50
```

**Note:** `for f in ...; do` bash syntax is invalid in PowerShell. Use `Get-ChildItem | ForEach-Object` instead. `Select-String -Last N` is also invalid — use `Select-Object -Last N`.

**Warning:** Running `bun --smol test tests/unit/tools` as a single batch will cause mock poisoning failures. Always use the per-file loop for directories in CI steps 4-6 (tools, services, agents, etc.).

The `--smol` flag reduces Bun's memory footprint. Use it when running large directories (50+ files).

The `--timeout 120000` flag sets per-test timeout to 120 seconds. Individual tests should complete in under 5 seconds. If a test needs more than 10 seconds, it's doing too much — split it or mock the slow dependency.

## Before Submitting

1. Run the tests for your changed files: `bun test path/to/your.test.ts`
2. Run the full CI group your tests belong to (see pipeline structure above)
3. Verify no `process.cwd()` usage — use the `directory` parameter from `createSwarmTool` or hook constructor
4. Verify no hardcoded paths (`/tmp/...`, `C:\...`) — use `os.tmpdir()` + `path.join()`
5. Verify mocks are restored in `afterEach` if using `spyOn` or `mock.module`

## Known Pre-existing Test Failures

The following test failures are pre-existing and unrelated to mock isolation:

| Test file | Failures | Cause | Status |
|-----------|----------|-------|--------|
| `tests/unit/hooks/full-auto-intercept.test.ts` | 21/37 | `logger.log` returns early without `OPENCODE_SWARM_DEBUG=1` | Pre-existing |
| `tests/unit/hooks/full-auto-intercept.dispatch.test.ts` | 2/46 | Same logger issue | Pre-existing |
| `tests/unit/commands/help-compound-commands.test.ts` | Multiple | Command routing issues | Pre-existing |
| `tests/unit/commands/index.test.ts` | Multiple | Command routing issues | Pre-existing |
| `tests/unit/commands/issue-command.test.ts` | Multiple | Command routing issues | Pre-existing |
| `src/__tests__/preflight-phase.test.ts` | 3/3 | `loadPlan` called twice per invocation (lines 930 + 545) | Bug exposed by cleanup |
| `tests/unit/agents/architect-sounding-board-protocol.adversarial.test.ts` | 1 | Token budget threshold `35000` exceeded by prompt growth; soft regression indicator that prompt size needs attention | Pre-existing |

## Known Cross-module mock.module Locations

The following directories contain test files that use cross-module `mock.module` (permitted under two-tier convention):

- `tests/unit/commands/` — mocks tools, hooks, services, state
- `tests/unit/hooks/` — mocks knowledge-store, knowledge-validator, knowledge-reader, telemetry, utils
- `tests/unit/tools/` — mocks Node built-ins (fs, child_process), sast-baseline, build/discovery
- `tests/unit/services/` — mocks path-security
- `tests/unit/config/` — mocks node:fs/promises
- `tests/unit/background/` — mocks utils, event-bus, evidence-summary-service
- `tests/unit/council/` — mocks node:fs
- `tests/unit/plan/` — mocks spec-hash
- `tests/unit/mutation/` — mocks node:child_process
- `tests/unit/git/` — mocks node:child_process
- `tests/integration/` — mocks co-change-analyzer, knowledge-store
- `src/__tests__/` — mocks plan/manager, preflight-service, telemetry
- `src/hooks/` — mocks logger, event-bus
- `src/tools/__tests__/` — mocks test-impact/analyzer, build/discovery, path-security
- `src/mutation/__tests__/` — mocks state
- `src/agents/` — mocks node:fs/promises
- `src/background/` — mocks vulnerability trigger

## Dead-code _internals Seams

The following source modules export `_internals` but have no test consumers (as of this writing). They are harmless but may be removed in future cleanup:

- `src/tools/secretscan.ts`
- `src/tools/knowledge-recall.ts`
- `src/tools/lint.ts`
- `src/tools/sast-scan.ts`
- `src/tools/sast-baseline.ts`
- `src/mutation/gate.ts`
- `src/mutation/equivalence.ts`
- `src/db/qa-gate-profile.ts`
- `src/config/schema.ts`
- `src/config/index.ts`
- `src/commands/registry.ts`
- `src/background/manager.ts`
- `src/background/event-bus.ts`
- `src/agents/critic.ts`
