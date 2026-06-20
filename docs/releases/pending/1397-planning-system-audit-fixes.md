---
release: pending
pr: 1397
title: "fix(planning-system): resolve audit findings F-03 through F-12"
date: 2026-06-19
---

## Summary

Resolves 8 audit findings (F-03, F-05, F-06, F-07, F-08, F-09, F-11, F-12) in the
planning system identified by a comprehensive planning-system audit.

## What changed

### Concurrent-write protection (F-03)

- `phase_complete` now acquires a file lock on `plan.json` before writing
- Lock acquisition failures now hard-fail (consistent with `save_plan` and
  `update_task_status`), preventing lost-update races on concurrent phase
  completions
- Lock is released in a `finally` block, guaranteed cleanup

### Atomic file operations (F-05, F-08)

- `writeCriteria` is now async and uses `atomicWriteFile` (temp + rename)
  instead of direct `writeFileSync`
- `phase_complete` fallback plan.json writes now use `atomicWriteFile`
- Prevents data corruption if the process crashes mid-write

### Plan state validation (F-07)

- `acknowledge-spec-drift` now verifies the staleness file's `specHash` still
  matches the current plan before accepting acknowledgment
- Rejects acknowledgment if the spec has changed since staleness detection,
  preventing invalid transitions

### Lock retry resilience (F-09)

- `tryAcquireLock` retry configuration changed from `{retries: 0}` to
  `{retries: 5, minTimeout: 10, maxTimeout: 500, factor: 2}`
- Transient lock contention no longer requires manual retry

### Documentation (F-06, F-11, F-12)

- Added JSDoc to `computePlanContentHash` explaining the difference from
  `computePlanHash` (Bun.hash vs SHA-256, plan.md drift vs plan state integrity)
- Added comment to `isPlanMdInSync` documenting the fuzzy substring fallback
  rationale and future cleanup intent
- Added JSDoc to `computePlanHash` explaining the intentional exclusion of
  `specMtime` and `specHash` fields

## Migration notes

No migration required. The changes are backward-compatible: the new lock
acquisition retries 5 times with exponential backoff before failing, so
transient contention resolves automatically.

## Tests

- File locks tests: 17 pass (unchanged)
- Criteria store tests: 6 pass (updated to async)
- Acknowledge spec drift tests: 16 pass (includes new F-07 regression test)
- `phase_complete` locking tests: updated to assert the new hard-fail behavior
  on lock contention
