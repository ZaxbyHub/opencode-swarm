# `fix(workflow)`: recover_stage_a_task and /swarm recover accept the chain-verified accepted_mutation receipt when no settlement WAL exists

## Summary

- Background-dispatched coder rounds never write a coder-settlement WAL, so the #2828 settlement-wedge recovery was structurally unavailable to exactly the tasks that need it: when a delivery was committed **before** a campaign (plan-identity) rebuild, every later coder re-dispatch settles truthfully as `dispatch_no_mutation`, `pre_check` attribution never opens, Stage B refuses with `TASK_WORKFLOW_STAGE_A_REQUIRED`, and every advertised remediation (`/swarm recover`, `recover_stage_a_task`, `recover_rework_task`) failed closed — the loop deadlocked with no sanctioned path at all (observed as the Wirtschaftssimulation task-1.8 wedge).
- Fix: the settlement justification is now resolved **WAL-first with a requirements-receipt fallback**. When no COMMITTED accepted settlement WAL exists, the chain-verified coder `accepted_mutation` receipt from the append-only `task-gate-requirements` ledger is the same durable settlement fact — recorded by the accepted mutation itself. Both the architect-supervised `recover_stage_a_task` and the deterministic `/swarm recover` scan use the shared resolver; green post-settlement pre-check bundles must still be newer than the receipt (bar unchanged).
- Safety: the receipt read is the existing fail-closed chain verifier (a corrupt hash/linkage propagates `TASK_GATE_REQUIREMENTS_CHAIN_MISMATCH` and refuses recovery); the WAL still wins when present (precedence pinned); the audited `stage_a_repair` event now records which receipt admitted the repair (`justification: settlement_wal | requirements_receipt` plus the receipt's transition id and generation).

## User-facing changes

- A task wedged by the campaign-rebuild Stage-A attribution gap (background coder, delivery committed before the rebuild, green pre-check bundles newer than the mutation) recovers via `recover_stage_a_task` from the architect session or the plain `/swarm recover` — no settlement WAL and no human-only escape needed anymore.

## Migration notes

None. The requirements ledger is unchanged; the recovery writes the same audited `stage_a_passed` transition the WAL path writes.

## Discovery context

The Wirtschaftssimulation `swarm_communication_debug.md` primary blocker (2026-11-23): task 1.8 idle at generation 3 with `retryHistory: dispatch_no_mutation x3`, the gen-1 `accepted_mutation` receipt present and chain-verified in `.swarm/evidence/task-gate-requirements/1.8.jsonl`, green secretscan/sast bundles from the same day, and `RECOVER_STAGE_A_SETTLEMENT_REQUIRED` refusing with "Background-dispatched coder tasks never write a settlement WAL and cannot use this path" — the refusal text itself named the structural gap. Pinned by `tests/unit/workflow/settlement-recovery-requirements-receipt.test.ts` (receipt-backed success for tool + deterministic scan, WAL precedence, the honest refusal when neither receipt exists, the stale-bundle bar, fail-closed on a tampered chain).
