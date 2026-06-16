# Resolve 20 advisory findings from final council review of reset/close refactoring

Resolves all 20 advisory findings from Issue #1167, the final council review of the `/swarm reset` and `/swarm close` refactoring work.

## What changed

- **Shared singleton helper:** Extracted `resetSwarmStatePreservingSingletons()` to `src/state.ts` — saves 7 module-scoped singletons (including the 2 previously missing), calls `resetSwarmState()`, restores them. Replaced the duplicated 5-singleton inline block in `close.ts`.
- **Junction/symlink guard:** Added `lstatSync` check to `/swarm close` that refuses to operate if `.swarm/` is a redirected directory (matching the existing `/swarm reset` guard).
- **Drift-prevention scan test:** Added `cleanup-drift.test.ts` that scans all `.swarm/` write patterns in `src/commands/` and `src/hooks/` and asserts each is accounted for by a cleanup command, preserve list, or explicit exemption.
- **Test coverage (6 new tests):** Plan-free session retro, `--skill-review` flag, `guaranteeAllPlansComplete` via `_internals`, EBUSY simulation, 7-singleton preservation assertion.
- **Minor fixes (12 items):** `.tmp.*` temp file sweep, `copyDirRecursive` extraction with tests, archive suffix fix in summary output, `--force` table in docs, `writePlan()` schema validity, sync/async split documentation, singleton count drift test, plus 7 additional documentation/hardening fixes.

## Why

The final council review identified code quality improvements, missing test coverage, and maintainability gaps across `reset.ts`, `close.ts`, and their test suites. These 25 tasks close all 20 non-blocking findings.

## Migration

No migration required. The shared helper API is internal (`src/state.ts`); all command behavior is unchanged.

## Breaking changes

None. All changes are backward-compatible internal refactoring and test additions.
