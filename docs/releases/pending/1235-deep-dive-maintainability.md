# Deep-dive maintainability improvements (issue #1235)

## What changed

Addressed 11 MEDIUM-severity maintainability findings from a deep-dive audit:

### Extracted shared helpers (FR-001, FR-002, FR-003, FR-005)
- **Gate boilerplate**: Extracted shared preamble into `gate-helpers.ts` used by 5 phase-complete gate files
- **Destructive-command subsystem**: Extracted 11 `dc*` functions from `guardrails.ts` into `guardrails/destructive-command.ts`
- **Worktree isolation**: Extracted 6 worktree functions from `delegation-gate.ts` into `delegation-gate/worktree-isolation.ts`
- **Guardrails factory split**: Split `guardrails.ts` (5122 lines) into barrel (45 lines) + 7 submodules, all under 2000 lines

### Type safety improvements (FR-004)
- Added 24 typed AST interfaces to `bash-parser.d.ts` module declaration
- Replaced all 20 `as Record<string, unknown>` unsafe casts in `shell-write-detect.ts` with typed access

### Test pattern migration (FR-008)
- Migrated `prm/index.test.ts` and `prm/integration.test.ts` from `vi.spyOn` to `_internals` DI seam pattern
- Eliminated cross-file mock leakage risk in Bun's shared test runner process

### Documentation of intentional patterns (FR-006, FR-007, FR-009, FR-010, FR-011)
- Added spec-referencing comments for: system-enhancer legacy block, state.ts multi-concern structure, `=== undefined` migration guards, high test-to-source ratios in security-sensitive tests

### Bug fix
- Fixed `council_parallel` schema default from `false` to `true` (was dead code with incorrect default)

## Why

The deep-dive audit identified structural maintainability concerns: large files exceeding 4000 lines, unsafe type casts, and test patterns that leak across files. This PR addresses all 11 findings with zero runtime behavior changes.

## Migration

No migration required. All changes are internal refactoring with preserved public API surfaces. Import paths for `src/hooks/guardrails` and `src/hooks/delegation-gate` continue to work unchanged.
