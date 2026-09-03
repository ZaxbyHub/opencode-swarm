# Plan-critic baseline drift: one hash definition, no more spurious BASELINE DRIFT

Issue: #2523

## Symptom

Every first phase-critic review after a plan approval opened with a spurious CRITICAL **BASELINE DRIFT — plan mutated after approval** finding, even when nothing had touched the plan. The tampering alarm fired on every healthy run, training operators to ignore the one signal that means "someone edited the plan behind your back."

## Cause

The drift comparison in `get_approved_plan` computed a **status-inclusive** digest (`computePlanHash`) and compared it against the **status-excluded** structure hash (`computePlanStructureHash`) that plan-critic approval snapshots store as their `payload_hash`. Two SHA-256 digests over different field sets can never be equal, so `drift_detected` was always `true` once the newest approval snapshot came from the plan-critic gate. A third writer (`write_drift_evidence` APPROVED) stored the status-inclusive digest instead — a second, inconsistent baseline definition.

## Change

- `computePlanStructureHash` is now **the single approval-baseline hash**. The decision is documented on the function: task/phase status is excluded because the baseline detects *plan edits*, not execution progress.
- `takeSnapshotEvent` enforces this at the write choke point: every `source: 'critic_approved'` snapshot's `payload_hash` is the structure hash, so all three approval writers (plan-critic gate recorder, `approve_plan_critic` override, `write_drift_evidence` APPROVED) store the same definition without having to remember an override.
- `get_approved_plan` compares structure hash against structure hash: a status-only change (task flipped to `in_progress`/`completed`) never reports drift; any structural change (description, acceptance criteria, dependencies, files, tasks/phases added or removed) always does.
- The status-inclusive ledger digest was renamed `computePlanHash` → `computePlanLedgerHash` (byte-identical output) with its own docstring, so the ledger hash chain, replay, epoch identity, and integrity checks are untouched. The old overlapping name is deleted — a grep ratchet (`tests/unit/plan/plan-hash-single-definition-ratchet.test.ts`) fails if a second plan-structure hash or the retired name is reintroduced.

## Migration

Plan-critic approvals recorded since the original #2012 fix already store the structure hash and now compare correctly. A `write_drift_evidence` APPROVED snapshot recorded **before** this release stores the old status-inclusive digest and will read as `drift_detected: true` until the next approval snapshot supersedes it — re-run the phase drift verifier (or `approve_plan_critic` / `/swarm approve-plan-critic`) once to record a fresh approval and clear the flag.
