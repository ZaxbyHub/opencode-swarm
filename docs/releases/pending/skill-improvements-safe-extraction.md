# Skill improvements: safe-extraction + mock-to-internals-migration

## What changed

### New skill: `safe-extraction`
Created a new generated skill covering the pattern of extracting code from a large monolith into submodules. Includes:
- Pre-extraction audit (CI invariant scripts, mock allowlists, test file inventory, import graph)
- Barrel re-export with explicit named exports
- Two extraction patterns: `_internals` proxy (for mockable subsystems) and factory parameter (for handler splits)
- SAST baseline recapture guidance
- CI allowlist update step

### Updated skill: `mock-to-internals-migration`
Added 6 improvements based on PR #1318 learnings:
- Step 0b: Check ALL test files consuming the target module (prevents cross-file regressions)
- `vi.spyOn` trigger condition (previously only covered `mock.module`)
- Safe-local-spy distinction table
- Generalized beyond `spawnSync` (applies to any injectable function)
- Verification checklist references Step 0b
- "When NOT to add a function to _internals" guidance

## Why
Both skill improvements were motivated by real issues encountered during PR #1318 (guardrails maintainability refactoring). The safe-extraction skill captures the complete extraction workflow that was learned through trial and error. The mock-to-internals-migration update closes a gap that caused an integration test regression.

## Migration
No migration required. Skills are consumed automatically by the swarm plugin's skill injection system.
