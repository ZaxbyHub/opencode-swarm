# Issue 849: Replace mock.module with _internals DI seam + strengthen adversarial assertions

## What changed

### Production code
- Added `spawnSync` to the `_internals` DI seam in `src/mutation/engine.ts` so tests can inject mocks without using `mock.module('node:child_process')`.
- All `spawnSync` calls in `executeMutation` now route through `_internals.spawnSync`.

### Test code
- Converted `src/tools/__tests__/mutation-test.adversarial.test.ts` from `mock.module('node:child_process')` to the `_internals.spawnSync` DI seam.
- Added proper save/restore lifecycle in `beforeEach`/`afterEach` per AGENTS.md invariant 7.
- Added `mockSpawnSync.mockReset()` in `afterEach` to prevent `mockImplementation` state leakage between tests.
- Added `rmSync(tempDir, { recursive: true, force: true })` in `afterEach` to clean up orphaned temp directories.
- Strengthened 7 weak adversarial assertions in `tests/unit/hooks/system-enhancer-evidence.adversarial.test.ts` that used `expect(result !== undefined).toBe(true)` to assert specific graceful-degradation behavior (`expect(result).toBeNull()`).

## Why

`mock.module('node:child_process')` leaks across Bun's shared test-runner process, contaminating subsequent test files. The `_internals` DI seam pattern (already used in `gitignore-warning.ts` and `diff-scope.ts`) eliminates this risk while keeping tests fast and type-safe.

Weak `!== undefined` assertions in adversarial tests only verified "didn't crash" rather than the system's actual response to attack vectors. Strengthening them catches regressions in graceful-degradation logic.

## Migration

No migration required. This is test-only infrastructure work.

## Known caveats

- A handful of pre-existing weak assertions remain in Task 3.4 tests of the system-enhancer adversarial file; those were outside the scope of Issue 849.
