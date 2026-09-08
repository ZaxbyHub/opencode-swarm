# PR-review transition authority

The PR-review reducer is a small, pure transition helper. It does not own the
whole PR-review lifecycle, and it cannot validate filesystem, delegation-ledger,
host-session, Git, or remote-publication state. Registered adapters perform
those checks under their existing locks and persist only through their existing
authorities. The reducer is used only where the event is an actual part of the
registered path; it must not become a second durable projection of another
authority.

## Registered event contract

The six reducer events that have production creators are:

| Event | Registered creator | State/effect authority |
| --- | --- | --- |
| `base_admission_rolled_back` | `rollbackPrReviewBaseAdmissionIfUnlaunched` in `src/hooks/pr-workflow-gate.ts` | The checkout/session-locked gate verifies that the batch is the tail and has no delegation record, applies the rollback, and persists the resulting state. The reducer rejects stale/non-tail or already-launched input with a typed rejection; the registered adapter maps that refusal to boolean `false` without mutating durable state. An identical adapter replay likewise returns `false` and cannot remove another batch. |
| `collection_observed` | The collection loop in `executeCollectLaneResults` in `src/tools/dispatch-lanes.ts` | Observation is diagnostic only. The exact bounded diagnostic is returned with the stored pending lane identities; no lane is cancelled or terminalized and no workflow state is written. A collection deadline or unavailable host client is not provider-terminal evidence. |
| `lane_structured_result_submitted` | The structured-result boundary in `src/hooks/pr-workflow-gate.ts` | The outer workflow lock validates the current session, head, workflow, and revision digest. The inner delegation-evidence lock publishes the child-bound receipt exactly once. A matching replay is a duplicate; a stale or conflicting receipt is rejected. Later terminal claiming settles the delegation and carries the receipt forward. |
| `circuit_advance_requested` | The staged-admission circuit adapter in `src/hooks/pr-workflow-gate.ts` | The adapter supplies current typed lane signals to the pure resilience machine and applies its result. Persist and block effects are honored; a HALF_OPEN probe is mark-on-success with the admission write. An adapter-level rejection fails soft to the pre-transition view. |
| `circuit_probe_settled` | The unlaunched-probe rollback path in `rollbackPrReviewBaseAdmissionIfUnlaunched` | Only the current HALF_OPEN probe can be ended by this path. A rolled-back probe returns the circuit to OPEN with a restarted cooldown; no contributor or generation is fabricated. Missing, stale, or repeated probe rollback returns `false` without mutation. Provider-outcome settlement belongs to the next circuit advance. |
| `resilience_config_changed` | The resilience-config adapter in `src/hooks/pr-workflow-gate.ts` | The current configuration is authoritative. A live disable persists the disabled policy; a re-enable starts a fresh waterlined CLOSED generation. Supplying the same policy again leaves the resilience policy, circuit, and attempts unchanged, although a distinct base-batch admission may still persist and increment the workflow revision. Schema-invalid configuration is rejected at the configuration boundary. |

These events have one source of truth for each mutation. The reducer's
`persist_state`, `block_dispatch`, `settle_delegation`, and diagnostic effects
are instructions to the registered adapter; they are not evidence that the
effect was durable until that adapter completes its lock/CAS or ledger write.

## Retired historical event names

The following names were retained by an earlier reducer-facing design but had
no production creator. They are retired from the reducer event union and remain
historical names in the authority registry so a future event cannot silently
become an unowned transition:

| Historical name | Replacement authority |
| --- | --- |
| `base_admission_requested` | `enforcePrReviewBaseDimensions` in the workflow gate |
| `transcript_evidence_presented` | Legacy transcript adapter plus the registered coverage predicates |
| `provider_terminal_observed` | Typed terminal settlement in `pending-delegations.ts` and the resilience signal adapter |
| `lane_cancelled` | Explicit cancellation/settlement in the registered collection, abort, and recovery paths |
| `coverage_finalization_requested` | `completePrWorkflow` and `src/pr-review/completion.ts` |
| `critic_result_recorded` | `composePrReviewPhaseVerdicts` and the critic result/report projection |
| `publication_armed` | The PR_FEEDBACK publication gate in `pr-workflow-gate.ts` |
| `publication_published` | The remote publication receipt and push/publication authority |
| `armed_recovery_requested` | `recoverArmedPrWorkflow` in the workflow gate |
| `reviewer_authorization_consumed` | The durable authorization store and its reservation CAS |

Retirement is intentional: wiring these events back into the reducer would
duplicate stronger authorities, add revision writes during validation, and make
lock ordering or replay semantics diverge. Critic terminality is defined by
the critic transport/composition contract: `UPHELD`, `DOWNGRADED`, and
`DISPROVED` settle; `NEEDS_MORE_EVIDENCE` remains nonterminal and cannot be
treated as a settled receipt. PR_REVIEW completion and PR_FEEDBACK publication
also remain separate authorities and must not be represented by one reducer
event.

## Verification expectations

Tests for this contract should drive registered functions, not only construct
reducer events. They should assert the durable state/effect, the typed refusal,
and an exact replay where the path is mutating. Observation-only paths must
assert the exact diagnostic and unchanged durable record. The focused
registered-path coverage is in
`tests/unit/pr-review/registered-transition-authority-2512.test.ts` and
`tests/unit/pr-review/registered-resilience-transition-authority-2512.test.ts`;
the dedicated resilience probe and observer replay suites cover their longer
multi-wave scenarios.

The registered admission API does not expose a caller-supplied CAS token;
stale-state protection is owned by its workflow/session lock and persistence
CAS. The registered same-policy test therefore treats unchanged resilience
substate plus a separately persisted batch/revision as the supported contract;
an external stale-CAS error is explicitly N/A at this adapter boundary.
