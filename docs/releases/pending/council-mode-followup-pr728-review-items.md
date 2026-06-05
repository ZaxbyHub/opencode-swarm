# council-mode follow-up fixes (PR #728 review items)

## What changed

This release addresses six follow-up items identified by the independent review council after completing PR #728 and its follow-up fixes.

### 1. REJECT evidence file assertion (tests)

Added a test in `tests/unit/tools/submit-phase-council-verdicts.unit.test.ts` that verifies the `phase-council.json` evidence file is written with `verdict: 'REJECT'` when a REJECT synthesis occurs. The previous test checked `parsed.overallVerdict === 'REJECT'` but never read the evidence file, leaving the write path unverified for the REJECT case.

### 2. Stage B barrier recorded during crash recovery (update-task-status.ts)

`recoverTaskStateFromDelegations` in `src/tools/update-task-status.ts` now calls `recordStageBCompletion` for both `reviewer` and `test_engineer` when evidence of their completion is found in delegation chains or evidence files. Previously, crash-recovery state advancement never updated the `stageBCompletion` barrier, creating a gap where the parallel barrier state was inconsistent with the recovered workflow state.

### 3. Stage B helper edge-case tests

Added `tests/unit/hooks/delegation-gate-stageB-edge-cases.test.ts` covering five edge cases for the Stage B advancement helpers in `createDelegationGateHook`:
- `null`/`undefined` `taskWorkflowStates` → advancement loop is skipped without error
- Exception during `advanceTaskState` is caught and does not propagate
- Parallel barrier with only reviewer → stays at `reviewer_run`, not `tests_run`
- `getSeedTaskId` returning null → cross-session seeding skipped
- Cross-session task seeding when task already exists → existing state not downgraded

### 4. `canAdvanceTaskState` predicate (state.ts)

Added `canAdvanceTaskState(session, taskId, newState, councilConfig?)` to `src/state.ts`. This predicate returns `true` iff `advanceTaskState` would succeed without throwing. Eliminates exception-based control flow at call sites that guard against illegal transitions using `INVALID_TASK_STATE_TRANSITION` as a control signal.

### 5. `stageBCompletion` cleared on task completion (state.ts)

`advanceTaskState` now clears `session.stageBCompletion.delete(taskId)` when `newState === 'complete'`. Previously the barrier Sets were append-only, risking premature barrier firing after a retry or task reset cycle.

### 6. `taskCouncilApproved` absence asserted in council-disabled test

Added `expect(session.taskCouncilApproved?.get('1.1')).toBeUndefined()` to the council-disabled `test_engineer` delegation test in `tests/unit/hooks/delegation-gate-council.test.ts`. The test previously verified state advanced to `tests_run` but did not assert the absence of a council verdict record.

## Why

All six items were identified by the independent review council after PR #728 follow-up work. Items 1 and 6 close test coverage gaps; Items 2 and 5 fix potential state consistency issues; Items 3 and 4 improve testability and control-flow clarity.

## Migration

No migration required. All changes are additive (new tests, new predicate export) or correctness fixes to in-memory state management with no persistence or API changes.

## Breaking changes

None.

## Known caveats

The `canAdvanceTaskState` predicate duplicates the `STATE_ORDER` array from `advanceTaskState`. If the valid state sequence changes, both functions must be updated.
