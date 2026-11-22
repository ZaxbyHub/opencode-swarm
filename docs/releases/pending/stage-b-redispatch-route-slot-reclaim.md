# `fix(workflow)`: a Stage-B re-dispatch can actually reclaim its route slot — the `reviewer_run` unwedging path works

## Summary

- The `test-engineer-exempt` wedge fix (re-dispatch the reviewer; the fresh exemption-aware receipt completes and the durable state advances) did not work in the field: the fresh reviewer dispatch's background completion was **terminally rejected** (`ingestion outcome: rejected`, advisory "reviewer task 1.8 ingestion failed") and the durable workflow stayed at `reviewer_run`, so `update_task_status` kept reporting `Missing gates: []` / `Contradictions: [all required proof exists but workflow state is reviewer_run]`.
- Root cause: route slots are single-assignment per dispatch. The wedged task's prior reviewer settlement had already appended a durable route binding for the identity (`1.8:reviewer:1` bound to the OLD `callId`/`childSessionId`, generation 1). When the fresh re-dispatch completed:
  1. `resolveBackgroundStageBRoute` found every reviewer slot occupied by the OLD dispatch (the in-memory evidence was lost at the host restart, so the durable requirements chain was consulted) → no binding for the fresh dispatch → the admission consult failed with `ROUTE_RECEIPT_DISPATCH_REQUIRED` → the completion was consumed terminal-negative, never recording evidence and never advancing the state;
  2. even if a binding had been computed, the persisted chain would later read BOTH the old and new rows for the same identity → `ROUTE_RECEIPT_DUPLICATE` on every downstream barrier.
- Fix (three surfaces, one semantic): a Stage-B re-dispatch of the same gate cycle **replaces the obsolete binding's slot** instead of finding it occupied forever —
  1. `resolveBackgroundStageBRoute` (`stage-b-gates.ts`, background completion ingestion): when no free slot exists for the role, a prior binding whose identity is listed in the CURRENT route receipt is reclaimed (same identity/slot, fresh `callId`/`childSessionId`); an exact replay of the same dispatch keeps its existing retry-replacement path; a foreign identity not listed in the current receipt is NOT reclaimed (fail-closed control pinned by test).
  2. `routeEvidenceFromTaskGateRequirements` (`evidence/task-gate-requirements.ts`): the durable chain is reconstructed latest-row-wins per `(role, identity)` — the superseded dispatch's row stays in the append-only audit chain but can no longer read back as a duplicate identity. Distinct identities (sibling slots) remain distinct entries.
  3. `delegation-gate.ts` foreground twin: `bindReviewRouteSlots` applies the same reclamation at dispatch time, the settlement's `prospectiveRouteEvidence` composition supersedes same-role+same-identity entries, and the settlement now falls back to the durable requirements chain when the (process-local) in-memory route evidence is empty — the post-restart shape that previously lost every sibling identity.

## User-facing changes

- A task durably wedged at `reviewer_run` (all required proof recorded, workflow never advanced — the pre-exemption-fix shape) now unwedges through the documented path: after updating the plugin, **re-dispatch the reviewer once more**; the fresh dispatch binds the reviewer identity, records `stage_b_completed` with `routeComplete: true`, the durable workflow advances to `tests_run`, and `update_task_status` admits the completion. No `/swarm recover` needed.
- Re-dispatched Stage-B agents after a host restart no longer lose their route slot claim to the pre-restart attempt, in both the background (Task ledger) and foreground (tool-hook settlement) paths.
- The exact identity-count guarantee is unchanged: a re-dispatch re-earns the SAME identity with exact fresh bindings (no extra identity is invented, duplicates still fail closed, and MAC-authenticated receipts still define the required identity set).

## Migration notes

None required. Existing durable requirements chains are read with the identity-keyed latest-wins reconstruction; no on-disk format changes.

## Discovery context

Found in the Wirtschaftssimulation loop (session `e07a3a7a-f3f6-49cc-8a03-d67c15158f0b`, task 1.8): after installing the exemption fix and re-dispatching the reviewer, the dispatch-time receipt was correctly allocation-exemption-aware (`reviewers: 1, testEngineers: 0`), but the background completion ledger recorded `ingestion: { state: "consumed", outcome: "rejected" }` while `.swarm/evidence/1.8.json` stayed at `reviewer_run` with `gates.reviewer` still stamped by the 11:49 dispatch — the fresh verdict was never recorded. The host had also switched the loop session's agent from `astra_architect` to `build` (temporary architect model override), which made `repair_gate_evidence` refuse with `TASK_GATE_EVIDENCE_ARCHITECT_ONLY` and removed every other in-session escape hatch. Pinned by `tests/unit/background/stage-b-redispatch-reclaim.test.ts`: the restart shape (durable chain only), the same-process shape (in-memory route evidence occupied), and a fail-closed control (a foreign identity occupying the slot is not reclaimed). Both regression tests fail on the pre-fix source with the terminal rejection and pass with the fix; the control passes on both.
