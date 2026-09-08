# PR-review transition authority (issue #2512)

The `PrReviewEvent` union (`src/pr-review/types.ts`) is the closed transition
vocabulary of the PR-review transition authority (`src/pr-review/reducer.ts`).
This table is the registered-path contract: **every declared event member has
a production construction site**, and every retired member names the executor
that owns its rule. The census is enforced by
`tests/unit/pr-review/reducer-adapter-authority.test.ts` (a new union member
without a production dispatch site fails that suite).

## Wire-or-retire table

| Event | Disposition | Production authority |
|---|---|---|
| base_admission_requested | wired | `enforcePrReviewBaseDimensionsWhileLocked` (`src/hooks/pr-workflow-gate.ts`) dispatches it for the `prReviewBaseDispatches` / `prReviewBaseDispatch` write after its richer lane-shape / tier / staged-admission validation; the adapter passes `maxBatches = MAX_WORKFLOW_BATCHES`, the same constant the inline pre-check enforces (the reducer rejection is defense in depth behind it and maps to the identical BLOCKED message) |
| base_admission_rolled_back | wired | `rollbackPrReviewBaseAdmissionIfUnlaunched` (`src/hooks/pr-workflow-gate.ts`) |
| collection_observed | wired | the collection observer inside `executeCollectLaneResults` (`src/tools/dispatch-lanes.ts`) |
| lane_structured_result_submitted | wired | the lane result submission path (`src/hooks/pr-workflow-gate.ts`; exactly-once replay by `semanticEnvelopeDigest`) |
| transcript_evidence_presented | retired | No-downgrade protection lives at the validation layer: `validateExactStructuredReceiptCoverage` plus the legacy-transcript compatibility gate (`src/hooks/pr-workflow-gate.ts`). Equivalence holds in BOTH legacy-compat modes — flag off (default): receipt-bearing lanes settle by receipt and legacy transcript parsing is refused; flag on: the structured receipt is validated first, so transcript rows can never alter a receipted lane. Rule coverage: `tests/unit/pr-review/replay-corpus-transcript.test.ts` |
| provider_terminal_observed | retired | Evidence classification lives in `classifyPrReviewCircuitSignal` (`src/pr-review/circuit.ts`), which filters invalid evidence sources to `ignored` before admission — outcome-equivalent (invalid evidence never becomes a circuit signal). The classifier emits cancellation/validation/unknown/`stale_observation`/parser reasons; the observer-deadline and client-unavailable never-terminal rules live in the lane-liveness and collect-timeout suites |
| lane_cancelled | retired | Operator cancellation settles by record identity in `collectOnce` cancel_pending (`src/tools/dispatch-lanes.ts`). Production semantics are operator-current by intent: the retired event's generation guard was never dispatched anywhere and would have rejected legitimate cancels after any state write (every CAS write bumps the durable revision), so retiring it preserves production behavior byte-for-byte |
| circuit_advance_requested | wired | the staged-admission advance path (`src/hooks/pr-workflow-gate.ts`) |
| circuit_probe_settled | wired | the rolled-back-probe path of `rollbackPrReviewBaseAdmissionIfUnlaunched` (`src/hooks/pr-workflow-gate.ts`) |
| resilience_config_changed | wired | the resilience config snapshot path (`src/hooks/pr-workflow-gate.ts`) |
| coverage_finalization_requested | wired | `completePrWorkflow` PR_REVIEW branch dispatches it with the settlement derived by `derivePrReviewDimensionSettlement`; the reducer enforces the production verdict matrix (COMPLETE → any; PARTIAL → never APPROVE; NO_COVERAGE → INCOMPLETE only) and the adapter maps typed rejections to the existing BLOCKED messages (`allowedPrReviewReportVerdicts` is used for message formatting only). The disclosure admission, audit event, and terminal clear remain adapter-owned |
| critic_result_recorded | wired | `assertPrReviewTerminalReady`'s critic gate derives settled receipts — `{findingId, status: UPHELD \| DOWNGRADED \| DISPROVED, reviewerRowDigest}` (the digest is the reviewer claim's `rowDigest` from `authoritativeReviewerClaims`; composition rejects unbound claims) — and dispatches the transition. UPHELD, DOWNGRADED and DISPROVED each satisfy assigned critic coverage; NEEDS_MORE_EVIDENCE is nonterminal (refused at the transport schema), so a required finding whose only critic verdict is NEEDS_MORE_EVIDENCE blocks completion |
| publication_armed | retired | Verdict/coverage compatibility at completion is owned by the wired `coverage_finalization_requested`; the PR_FEEDBACK arming write itself is the generation-governed transition documented in `docs/pr-feedback-publication-generations.md` |
| publication_published | retired | Publication settlement in `completePrWorkflow` (`src/hooks/pr-workflow-gate.ts`) verifies the revision digest, Git HEAD, worktree, upstream triple and remote refs — facts a pure reducer cannot observe (see below) |
| armed_recovery_requested | wired | `recoverArmedPrWorkflow` (`src/hooks/pr-workflow-gate.ts`) dispatches it for the `prReviewDimensionCancellations` write; the event carries the operator's sanitized reason so the persisted record is byte-identical to the pre-wiring inline write. The executor keeps identity/digest validation, the audit event, and the publication-authorization invalidation |
| reviewer_authorization_consumed | retired | `reservePrReviewReentryAuthorizationAgainstBinding` (`src/pr-review/authorization.ts`) is the storage-backed reserve: binding + role against live state under lock, with TTL, pruning and same-call replay. Rule coverage: `tests/unit/hooks/pr-review-reentry-authorization.test.ts` |

## Binding-field authority split

`PrReviewAuthorizationBinding` fields are validated at the authority that can
actually observe them:

- `sessionID`, `workflowInstanceId`, `prHeadSha`, `generation` — the reducer
  (`bindingRejection`) against `PrReviewWorkflowState`, which carries them.
- `revisionDigest` — only the executor that resolved it: armed recovery
  validates it against the armed publication record
  (`recoverArmedPrWorkflow`), and re-entry validation compares it against the
  live binding context (`authorization.ts`).

Current-state reads, session locks, and the compare-and-swap revision check at
every mutation boundary are unchanged by the wiring.

## The concurrent-storage limit

**A pure reducer cannot independently observe a concurrent storage mutation.**
The reducer sees only the state slice it is handed. Authorization records,
armed publication generations, and Git facts live in storage the gate reads
under a lock at the moment of the decision — which is exactly why re-entry
consumption and publication settlement stay at their executor authorities
rather than becoming reducer events. A reducer event is the right home for a
transition whose truth is a function of the workflow state alone.

## PR_REVIEW completion vs PR_FEEDBACK publication

These are separate transitions and neither proves the other. PR_REVIEW
completion validates coverage settlement, critic coverage, verdict
truthfulness and the terminal artifact ladder; PR_FEEDBACK publication
validates the armed generation's exact identity (digest, HEAD, worktree,
upstream, remote refs) before any push. Completing a review never publishes,
and a publication generation never credits review coverage.

## Guardrail

`tests/unit/pr-review/reducer-adapter-authority.test.ts` re-runs the census on
every test run: it extracts the union discriminants from `types.ts` and
requires at least one `type: '<event>'` production literal outside
`types.ts`/`reducer.ts`. Declaring a new event without wiring (or retiring) it
fails CI.
