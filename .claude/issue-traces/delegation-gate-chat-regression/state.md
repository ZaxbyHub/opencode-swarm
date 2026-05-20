# Issue Trace State

## Phase: 2 (Root Cause Localized)
## Status: Ready for fix plan

## Root Cause
- File: `src/state.ts`
- Lines: 521, 1046, 1169, 1188
- Issue: `console.warn()` used directly instead of project's debug-gated `logger.warn()`
- Effect: All warn messages leak into OpenCode chat stream

## Key Message (from screenshot)
"[delegation-gate] Council mode mismatch for plan ..." at line 1188

## Fix Approach
Add `import * as logger from './utils/logger'` to src/state.ts and replace all 4 `console.warn()` calls with `logger.warn()`

## Next Action: Implement fix
