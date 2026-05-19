---
name: mock-to-internals-migration
description: >
  Apply when converting test files from mock.module('node:child_process') to _internals DI seam pattern.
  Guides the complete migration: adding spawnSync/_internals to source files, converting test files,
  adding proper beforeEach/afterEach save/restore lifecycle, mockReset() cleanup, and temp directory cleanup.
  Prevents mock.module leaks across Bun's shared test-runner process.
effort: medium
---

# mock.module → _internals DI Seam Migration Protocol

Follow every step in order. Do not skip steps.

## When to use this skill

- A test file uses `mock.module('node:child_process')` or `mock.module('node:fs')` or similar
- The production code already has an `_internals` export (or needs one added)
- The goal is to eliminate `mock.module` usage per AGENTS.md invariant 7 and the writing-tests skill

**Benefit:** This migration also sidesteps the Windows EBUSY risk documented in the writing-tests skill — tests using `_internals` seams do not need `mock.restore()`, which on Windows can conflict with async child process handles.

## Step 0 — Identify the target module and its _internals seam

1. Find where the test imports from:
   ```typescript
   import { _internals as engineInternals } from '../../mutation/engine.js';
   ```
2. Read the source module (e.g., `src/mutation/engine.ts`)
3. Check if `_internals` already exists:
   ```typescript
   export const _internals = { ... };
   ```
4. Identify which function/method the mock.module was intercepting (usually `spawnSync`, `execFileSync`, `readFileSync`, etc.)

## Step 1 — Add the function to _internals in the source file

**CRITICAL:** Do NOT import type aliases from Node.js built-ins (e.g., `type SpawnSyncFn` from `node:child_process`). Use `typeof` instead.

```typescript
// BAD — fails build
import { spawnSync, type SpawnSyncFn } from 'node:child_process';

// GOOD — works at build time
import { spawnSync } from 'node:child_process';
type SpawnSyncFn = typeof spawnSync;
```

Add the function to `_internals`:
```typescript
export const _internals: {
  executeMutation: typeof executeMutation;
  computeReport: typeof computeReport;
  executeMutationSuite: typeof executeMutationSuite;
  spawnSync: SpawnSyncFn;  // ← ADD THIS
} = {
  executeMutation,
  computeReport,
  executeMutationSuite,
  spawnSync,  // ← ADD THIS
} as const;
```

> **Note:** The explicit type annotation on `_internals` (the `{ ... }` shape on the left side of `=`) overrides `as const` readonly inference. If you omit the explicit type annotation, `as const` will make properties `readonly` and test injection (`engineInternals.spawnSync = mockSpawnSync`) will fail at TypeScript compile time. Always include the explicit type annotation.

Replace all direct calls in the module with `_internals.spawnSync(...)`:
```typescript
// BEFORE
const result = spawnSync('git', ['apply', patchFile], { cwd: workingDir });

// AFTER
const result = _internals.spawnSync('git', ['apply', patchFile], { cwd: workingDir });
```

**Verify:** Run `bun run build` to ensure the type alias compiles.

## Step 2 — Convert the test file

### 2a. Remove mock.module block

Delete the entire `mock.module(...)` block and any related mock setup.

### 2b. Add module-level variables for save/restore

```typescript
// Module-level reference to the original function (saved/restored in beforeEach/afterEach)
let originalSpawnSync: typeof import('node:child_process').spawnSync | undefined;

// Module-level mock that logs calls and delegates to original
const mockSpawnSync = mock(
  (cmd: string, args: string[], opts: Record<string, unknown>) => {
    spawnCallLog.push({ cmd, args, opts: { ...opts } });
    if (originalSpawnSync) {
      return originalSpawnSync(cmd, args, opts);
    }
    return {
      pid: 12345,
      output: Buffer.alloc(0),
      stdout: Buffer.from('ok'),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
      error: undefined,
    } as ReturnType<typeof import('node:child_process').spawnSync>;
  },
);
```

### 2c. Update beforeEach

```typescript
beforeEach(() => {
  // Save original and replace with mock
  originalSpawnSync = engineInternals.spawnSync;
  engineInternals.spawnSync = mockSpawnSync;
  spawnCallLog.length = 0;
  tempDir = makeTempDir();
});
```

### 2d. Update afterEach

**CRITICAL:** Must include ALL of these in order:
1. Restore original function
2. Call `mockReset()` to clear mockImplementation state
3. Clean up temp directories
4. Clear call logs

```typescript
afterEach(() => {
  // 1. Restore original
  engineInternals.spawnSync = originalSpawnSync;
  // 2. Reset mock implementation to prevent leak between tests
  mockSpawnSync.mockReset();
  // 3. Clean up temp directory
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  // 4. Clear call log
  spawnCallLog.length = 0;
});
```

**WARNING:** Omitting `mockReset()` causes `mockImplementation` state from one test to leak into the next test's active window.

### 2e. Update test assertions

Replace assertions that checked `mockSpawnSync.mock.calls` with assertions that check `spawnCallLog`:
```typescript
// BEFORE (with mock.module)
expect(mockSpawnSync).toHaveBeenCalledWith('git', ['apply', ...]);

// AFTER (with _internals seam)
const gitCalls = spawnCallLog.filter(c => c.cmd === 'git');
expect(gitCalls.length).toBeGreaterThan(0);
```

## Step 3 — Verify no mock.module remains

```bash
grep -n "mock.module" <your-test-file>
```
Must return no matches.

## Step 4 — Run tests

```bash
bun --smol test src/tools/__tests__/mutation-test.adversarial.test.ts --timeout 30000
```

## Step 5 — Check for helpers that bypass the seam

Some test helpers (like `initGitRepo`) may use `require('node:child_process')` directly to bypass the mock. This is INTENTIONAL and CORRECT — they need the real subprocess to set up test fixtures.

```typescript
function initGitRepo(dir: string): void {
  const { spawnSync: s } = require('node:child_process');
  s('git', ['init'], { cwd: dir });
}
```

Do NOT change these helpers to use the DI seam.

## Common mistakes

| Mistake | Why it fails |
|---------|-------------|
| Forgetting `mockReset()` in `afterEach` | `mockImplementation` state leaks between tests |
| Using `type SpawnSyncFn` import from `node:child_process` | Type export doesn't exist at runtime; build fails |
| Forgetting to restore `_internals.spawnSync` | Subsequent tests or other files get the mock |
| Using async `fs.rm` in `afterEach` without `await` | Temp directories not cleaned up; use `rmSync` |
| Converting `initGitRepo`-style helpers | These need the REAL subprocess; keep them as `require()` |

## Verification checklist

- [ ] Source file `_internals` includes the function
- [ ] All calls in source use `_internals.fn(...)`
- [ ] Test file has no `mock.module` calls
- [ ] `beforeEach` saves original and assigns mock
- [ ] `afterEach` restores original, calls `mockReset()`, cleans temp dir
- [ ] All tests pass
- [ ] `bun run build` passes
