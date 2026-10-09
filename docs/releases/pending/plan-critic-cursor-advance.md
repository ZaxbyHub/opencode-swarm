# Fix: completing a phase no longer voids the plan-critic approval

## What

The `critic_pre_plan` gate compares the plan with the last plan-critic approval
snapshot using the structural plan hash. Task and phase statuses are excluded
from that hash, but the `current_phase` cursor is included (#2532). Completing
a phase's last task advances the cursor, so the first coder dispatch of the next
phase was refused with `PLAN_CRITIC_GATE_VIOLATION`, even though nobody had
edited the plan.

The approval snapshot stores the approved plan. The gate, `isPlanCriticApproved`
and `get_approved_plan`'s `drift_detected` now all use one check
(`approvedSnapshotCoversPlan` in `src/plan/ledger.ts`), which also accepts a
current plan that differs from the approved plan **only** in the cursor. The snapshot must be self-consistent,
and re-hashing its plan at the current cursor must give the current plan's
hash.

Unchanged:
- every structural edit (descriptions, files, dependencies, tasks, phases)
  still invalidates the approval;
- the hash function and the stored `payload_hash` bytes.

## Why

Found in a live run: after phase 1 completed, the architect had to re-run the
plan critic before phase 2 could start, for an unchanged plan.
