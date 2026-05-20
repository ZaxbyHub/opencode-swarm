# Gate Pass 2 Cross-Task Isolation Fix

## Overview

Fixes two related correctness gaps introduced by PR #931's unscoped Pass 2 delegation chain scan in `checkReviewerGate` and `recoverTaskStateFromDelegations`. Without this fix, a concurrent pure-verification task's coder-free delegation chain (containing `reviewer` and `test_engineer` entries) could satisfy a different code task's QA gate when that code task's reviewer/test_engineer hooks had silently failed — bypassing an evidence file that explicitly recorded the gates as incomplete.

## Bug Fixes

- **`src/tools/update-task-status.ts` — `checkReviewerGate` Pass 2**: Added `!evidenceIncompleteReason` guard before Pass 2's unscoped chain scan. When the evidence file for the task has already named missing required gates, Pass 2 is skipped entirely. This is consistent with the existing guards at lines 301 and 331 that use the same signal to prevent vacuous session-zero passes. The guard does not affect the intended pure-verification use case because those tasks either have no evidence file (`evidenceIncompleteReason === null`) or have a fully-satisfied evidence file (which returns `blocked: false` at the evidence-first check before Pass 2 is ever reached).

- **`src/tools/update-task-status.ts` — `recoverTaskStateFromDelegations` Pass 2**: Added `hasDurableIncompleteGates` pre-check that reads the durable evidence file for the task before the unscoped chain scan. If the file records `required_gates.length > 0` with any missing gate entries, the function skips Pass 2 and does not advance session state. This closes the two-stage contamination path where `recoverTaskStateFromDelegations` advanced state to `tests_run` (via a concurrent task's chains) before `checkReviewerGate` ran — allowing the session-state check to pass without the evidence guard ever being consulted.

## Tests

Three regression tests added to `src/tools/update-task-status.gates.test.ts` under the label `regression F1: Pass 2 cross-task isolation`:

1. `checkReviewerGate` blocks a code task when a concurrent pure-verification session's chain holds `reviewer`+`test_engineer` but the code task's evidence shows incomplete gates.
2. `recoverTaskStateFromDelegations` does not advance a code task's state to `tests_run` using a concurrent pure-verification session's chain when durable evidence records incomplete gates.
3. Positive control: `checkReviewerGate` still passes for a pure-verification task that has no evidence file (the intended use case is unaffected).

## Breaking Changes

None. The fix is additive: tasks that were correctly passing before continue to pass. Tasks that were incorrectly passing due to cross-task chain leakage now correctly block.
