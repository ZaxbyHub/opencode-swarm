# Follow-up: Generated skills from Issue #849 resolution

## What changed

Created `.opencode/skills/generated/mock-to-internals-migration/SKILL.md` — a
project-generated skill documenting the complete protocol for converting test
files from `mock.module('node:child_process')` to the `_internals` dependency
injection seam pattern.

Updated `.claude/skills/writing-tests/SKILL.md` with three new sections:

1. **Mock lifecycle cleanup** — `mockReset()` must be called in `afterEach` (not
   `beforeEach`) to clear `mockImplementation` state between tests; `mockClear()`
   in `beforeEach` only clears call history.

2. **TypeScript alias pattern for DI seams** — use `type SpawnSyncFn = typeof
   spawnSync` instead of importing named type exports from `node:child_process`
   that don't exist at runtime.

3. **Weak assertion anti-pattern** — `expect(result !== undefined).toBe(true)`
   must be replaced with precise assertions like `expect(result).toBeNull()` or
   `expect(result).toBeDefined()`.

## Why

These skills capture the lessons learned during the Issue #849 fix so that
future migrations and test authoring follow the same patterns without
rediscovering the pitfalls (Bun `mock.module` isolation leaks, runtime type
errors, vague assertions).

## Migration

No migration required. These are additive documentation changes.

## Known caveats

- The `mock-to-internals-migration` skill is generated (not hand-written) and
  should be reviewed before being promoted to a permanent team skill.
- The `writing-tests` skill updates apply immediately to all agents that load it.
