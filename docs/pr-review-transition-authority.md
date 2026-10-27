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
| provider_terminal_observed | retired | Evidence classification lives in `classifyPrReviewCircuitSignal` (`src/pr-review/circuit.ts`), which filters invalid evidence sources to `ignored` before admission — outcome-equivalent (invalid evidence never becomes a circuit signal). The classifier emits cancellation/validation/unknown/`stale_observation`/parser reasons; `observer_deadline` is derived by the lane-liveness watchdog (`src/hooks/lane-liveness-watchdog.ts`; precedence pinned by `tests/unit/hooks/lane-liveness-outcomes.test.ts`) and admitted as `ignored` evidence (`tests/unit/pr-review/reducer-transitions-circuit.test.ts`); `client_unavailable` remains a declared reason in the same union with no wired transition, by design |
| lane_cancelled | retired | Operator cancellation settles by record identity in the authorized cancel surface (`cancel_lane_batch`, `src/tools/cancel-lane-batch.ts`, since issue #2971; the collector's `cancel_pending` is observation-only guidance). Production semantics are operator-current by intent: the retired event's generation guard was never dispatched anywhere and would have rejected legitimate cancels after any state write (every CAS write bumps the durable revision), so retiring it preserves production behavior byte-for-byte |
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

## Settle/admit call-site census

Issue #2908. Where the wire-or-retire table above censuses the reducer's event
VOCABULARY, this table censuses the WRITE SIDE: every call site that can
write a terminal delegation status, trigger a lane settlement, or admit
PR-review coverage. Three authorities anchor it — the terminal-claim primitive
`claimTerminalResult` (`src/background/pending-delegations.ts`), its lane
lifecycle wrapper `settleDelegationTerminal`
(`src/background/delegation-lifecycle.ts`, "one claim implementation, no
second lifecycle state machine", issue #2045), and the typed reducer
`reducePrReviewEvent` (`src/pr-review/reducer.ts`), whose emitted
`settle_delegation` effects are executed through the claim primitive.

Row classes, all enforced by
`tests/unit/pr-review/settle-admit-census-ratchet-2908.test.ts` through the
scanner `tests/helpers/terminal-writer-scanner.ts`:

- `scan` — the identity owns at least one scanner hit from the ten call
  patterns: the settle and claim primitives, the sweep invocations in any
  textual form (including the `_test_exports` seam form),
  `appendDelegationTransition` calls carrying a terminal status literal OR
  whose payload status the scanner cannot statically resolve to a literal
  (fail closed: a bare-identifier payload is censused; only a payload
  resolving to a non-terminal literal such as `status: 'running'` stays
  excluded), `buildTypedDelegationTerminal`
  constructions, the lane-settlement trigger, the admission sinks
  (definitions AND call sites, including the
  `admitPrReviewPartialBaseCoverageFromCompletion` alias), and the two
  whole-ledger raw writers (`writeDelegationShadowProjection`,
  `compactDelegationsLocked`). A
  `scan` row's authority is `routed` (through the claim primitive or a named
  admission authority) or `deliberate-second-authority` (a direct write whose
  structural reason is cited in the row).
- `inventory` — the identity owns only raw `appendRecord(` hits inside the
  delegation store, which is the store's internal record writer. Pattern 6 is
  scoped to that file; the `appendRecord(` homonyms in
  `src/hooks/knowledge-receipt-ledger.ts` and `src/training/capture.ts`
  belong to other subsystems with no delegation terminal-write capability.
- `cross-reference` — authority families whose own census lives elsewhere
  (the reducer's own wire-or-retire table, the coder-settlement WAL, the
  Stage-B binding store).

Dispositions are `routed` or `deliberate-second-authority`. A disposition of
`straggler` means "un-inventoried or un-justified"; the table ships with
none: every direct write carries a verifiable structural reason — most often
that the claim primitive refuses `ingestion_error` records and record-less
correlations, so a bulk sweep or a CAS flip cannot route through it.

### Coupling rule

Each row's `Site` is `file:function`, where `function` is the innermost
ENCLOSING named declaration, resolved from the TypeScript AST rather than a
line-anchored regex; a hit with no enclosing named declaration attributes to
`<module>`. The `Writes or admits` column lists the scanner hit lines for
that identity as `:NNNN, :NNNN`. The ratchet enforces the coupling in three
directions: every scanner identity owns exactly one row of the right class;
every `scan`/`inventory` row's cited hit lines equal that identity's actual
hit lines compared as a MULTISET of lines — each cited `:NNNN` occurrence
consumes exactly one actual hit occurrence, so a NEW call site inside an
already-inventoried function fails as an un-cited hit even when it lands on
a line the row already cites, and a stale citation fails as a phantom; and
every disposition is a census token with zero `straggler` rows.

### Replication-writer seam

The coordination layer replicates already-decided records through two raw
sinks: `writeDelegationShadowProjection` (whole-ledger rewrite) and
`transitionCoordinationState` under the `background.pending-delegation`
namespace (a generic coordination API shared by other subsystems, so it is out
of per-call-site scope here). Both are REPLICATION writers — every record they
carry was already terminalized by a censused authority above — and both are
censused (patterns 9 and 10). Note the authority direction, which is easy to
invert: once the coordination DB is imported, ordinary reads SERVE the SQLite
coordination rows, and the ledger file plus the checkpoint and manifest are
projections that `ensureDelegationCoordinationImported` re-folds as a shadow
reconciliation on every read (`docs/sqlite-durable-state.md` records the same
post-commit-shadow model). The residual risk this census cannot close: a future
writer that introduces a NEW terminal decision through the coordination seam
instead of through a censused authority.

| Site | Writes or admits | Authority | Row class | Disposition | Reason |
|---|---|---|---|---|---|
| src/background/completion-observer.ts:createBackgroundCompletionObserver | :293, :468 | claimTerminalResult for the terminal; appendDelegationTransition for the staleness flip | scan | routed | Task-side terminal (:293) routes through the claim primitive; the Stage-B staleness flip (:468) is an INTENTIONAL-EVENTLESS #2700 post-claim terminal-to-terminal transition (the record already carries its typed terminal event) that emits an advisory and discards scope |
| src/background/completion-observer.ts:settleCoder | :913 | appendDelegationTransition (preserved -> stale) | scan | deliberate-second-authority | INTENTIONAL-EVENTLESS #2700 post-claim flip: the typed terminal came from the claim that opened the coder settlement, so the transition establishes no new first-terminal event |
| src/background/delegation-lifecycle.ts:settleDelegationTerminal | :192 | claimTerminalResult via _internals | scan | routed | #2045: the lane lifecycle wraps the SAME claim primitive the Task completion observer calls directly (one claim implementation, no second lifecycle state machine) |
| src/background/pending-delegations.ts:<module> | :1233, :2585, :4506 | claimTerminalResult plus the two whole-ledger raw writers | scan | routed | module-scope declarations. :4506 is the terminal-claim authority itself — it DECIDES the terminal, so it is not a replication writer. :1233 and :2585 are replication-only: the coordination shadow projection and checkpoint/ledger compaction carry records an already-censused authority decided |
| src/background/pending-delegations.ts:acknowledgeObservedBackgroundAdvisories | :5676 | appendRecord (delegation store raw writer) | inventory | routed | advisory acknowledgment payload write; no terminal status |
| src/background/pending-delegations.ts:appendDelegationTransition | :3637, :3668 | typed transition write (buildTypedDelegationTerminal) | scan | deliberate-second-authority | the CAS transition primitive the deliberate writers use; it carries the typed terminal event with identity rules identical to the claim path |
| src/background/pending-delegations.ts:appendRecord | :3304 | raw append sink plus coordination replication | scan | routed | the single append sink every censused authority flows through; its coordination row under the background.pending-delegation namespace is a replica of the just-decided record |
| src/background/pending-delegations.ts:claimCoderSettlement | :4754 | appendRecord (delegation store raw writer) | inventory | routed | coderSettlement claim marker; the terminal settlement state is written by updateCoderSettlement |
| src/background/pending-delegations.ts:claimDelegationIngestion | :5235 | appendRecord (delegation store raw writer) | inventory | routed | ingestion claim marker; no terminal status |
| src/background/pending-delegations.ts:claimTerminalResult | :4625 | appendRecord (delegation store raw writer) | inventory | routed | the terminal-claim authority body; the append it performs is the scan-classified authority itself |
| src/background/pending-delegations.ts:compactBackgroundDelegations | :2574 | compactDelegationsLocked | scan | routed | the public checkpoint/ledger compaction wrapper |
| src/background/pending-delegations.ts:ensureDelegationCoordinationImported | :1324, :1370 | coordination import plus shadow projection | scan | deliberate-second-authority | replication-only: one-time import of already-decided records into the coordination DB, then projection repair |
| src/background/pending-delegations.ts:maintainBackgroundDelegations | :7655 | sweepStaleDelegations | scan | routed | startup/session maintenance sweep through the sweep authority |
| src/background/pending-delegations.ts:maybeCompactDelegationsLocked | :2927 | compactDelegationsLocked | scan | routed | high-water compaction trigger for the checkpoint/ledger writer |
| src/background/pending-delegations.ts:preparePendingBackgroundAdvisories | :5536 | appendRecord (delegation store raw writer) | inventory | routed | advisory payload preparation; no terminal status |
| src/background/pending-delegations.ts:promoteDelegationFallback | :6395 | appendRecord (delegation store raw writer) | inventory | routed | recovery surface re-appending an already-decided record from the fallback store |
| src/background/pending-delegations.ts:publishPrReviewResultReceipt | :3831, :3917, :3965 | claim-first admission then the typed terminal | scan | deliberate-second-authority | #2865: deliberately supersedes a provably-stale error/contract terminal with a completed receipt-backed terminal under separate rules, documented in the claim primitive own contract; #3313 AC15 rejects a finding id already claimed by another lane of the same run before any write, so a duplicate id can never reach the append |
| src/background/pending-delegations.ts:putPendingBackgroundAdvisory | :5380 | appendRecord (delegation store raw writer) | inventory | routed | advisory payload write; no terminal status |
| src/background/pending-delegations.ts:recordDelegationIngestionResult | :5309 | appendRecord (delegation store raw writer) | inventory | routed | ingestion result write; status-adjacent but not terminal |
| src/background/pending-delegations.ts:recordPendingDelegationDetailed | :3488, :3510 | sweepStaleDelegations plus appendRecord | scan | routed | record creation pre-sweeps a stale record through the sweep authority and appends the initial non-terminal record |
| src/background/pending-delegations.ts:releaseBackgroundAdvisoryPreparation | :5603 | appendRecord (delegation store raw writer) | inventory | routed | advisory payload write; no terminal status |
| src/background/pending-delegations.ts:replacePendingBackgroundAdvisory | :5454 | appendRecord (delegation store raw writer) | inventory | routed | advisory payload replacement; no terminal status |
| src/background/pending-delegations.ts:supersedeStaleLivenessVerdictLane | :4200, :4215 | typed supersession terminal (buildTypedDelegationTerminal) plus appendRecord | scan | deliberate-second-authority | #3313 AC32-AC35: a late valid transcript supersedes a terminal stale/liveness reviewer/critic record under the store lock; the claim primitive cannot act on an already-terminal record. Refuses operator_cancelled terminals, discovery modes, and records cited by a persisted verdict-settlement receipt (both phase receipts re-read at decision time); the validated rows REPLACE the result and the stale error text and liveness class are dropped, with the typed completed terminal written atomically by the same append |
| src/background/pending-delegations.ts:sweepStaleDelegations | :5977 | sweepStaleLocked | scan | routed | public bulk sweep wrapper; its status and age filters are the safety property the gate force-override relies on (#2251) |
| src/background/pending-delegations.ts:sweepStaleLocked | :5888, :5894 | direct typed-terminal append | scan | deliberate-second-authority | the claim primitive refuses ingestion_error records and requires per-record claimable state, so this bulk stale flip cannot route through it; the typed terminal is written atomically with the disposition and the #2482/#2244 eventless-terminal-end observer fires |
| src/background/pending-delegations.ts:updateCoderSettlement | :4932 | appendRecord (delegation store raw writer) | inventory | routed | the coderSettlement terminal settlement state (settled/preserved) written for an already-claimed terminal |
| src/background/pending-delegations.ts:updateLegacyCoderSettlementTransfer | :5120 | appendRecord (delegation store raw writer) | inventory | routed | legacy settlement transfer state; no terminal status |
| src/hooks/pr-workflow-gate.ts:<module> | :7747 | admitPrReviewPartialBaseCoverage (completion module) | scan | routed | module-scope admission wrapper DEFINITION (the definition-name match sits outside the body span, so it attributes here); the wrapper's body dispatches to the completion-module authority below, so coverage admission state is written by that state-snapshot authority |
| src/hooks/pr-workflow-gate.ts:abortPrWorkflow | :4646 | settlePresumedStalePrWorkflowLanes sweep | scan | routed | force-abort entry point; its lane settlement routes through the sweep authority and its pr_feedback_publication_cancelled terminal events are the publication surface own vocabulary |
| src/hooks/pr-workflow-gate.ts:admitPrReviewPartialBaseCoverage | :7753 | admitPrReviewPartialBaseCoverageFromCompletion (completion module) | scan | routed | the wrapper's body dispatches to the completion-module admission authority through the aliased import admitPrReviewPartialBaseCoverageFromCompletion (src/pr-review/completion.ts) — an aliased dispatch pattern 8 censuses by name; coverage admission state is written by that state-snapshot authority |
| src/hooks/pr-workflow-gate.ts:assertPrReviewTerminalReady | :12616 | settlePresumedStalePrWorkflowLanes sweep | scan | routed | terminal-readiness ladder; lane settlement routes through the sweep authority |
| src/hooks/pr-workflow-gate.ts:assertPrReviewValidationSettled | :8285 | persistVerdictSettlementReceipt | scan | routed | #3101: N-of-M verdict-settlement admission with a durable receipt written by the verdict-settlement store |
| src/hooks/pr-workflow-gate.ts:completePrWorkflow | :14475, :14725 | settlePresumedStalePrWorkflowLanes sweep plus admitPrReviewPartialBaseCoverage | scan | routed | completion triggers lane settlement through the sweep authority and admits partial coverage through the completion-module authority; its coverage finalization dispatches coverage_finalization_requested (wire-or-retire table above). #3312: the honest-INCOMPLETE exit's skip-disclosure admission is also written here — a withSessionStateMutation/writeStateWhileLocked write persisting the `prReviewValidationSkipDisclosure{,Path,Digest}` gate-state mirror fields alongside the durable `.swarm/pr-review/<runId>/validation-skip-disclosure.json` artifact (the artifact write rolls back when the state write fails), admitted only after all lanes settle and the workflow stays bound to the head, and never for APPROVE/REQUEST_CHANGES |
| src/hooks/pr-workflow-gate.ts:finalizeOverriddenProbeRetainedLanes | :4390 | sweepStaleDelegations with the operator_cancelled class | scan | deliberate-second-authority | #2971: an explicit audited operator action finalizing exactly the named retained lanes; it must not force a terminal, which is why it uses the sweep status/age filters rather than a raw transition |
| src/hooks/pr-workflow-gate.ts:recoverArmedPrWorkflow | :5139 | settlePresumedStalePrWorkflowLanes sweep plus reducePrReviewEvent | scan | routed | armed recovery settles lanes through the sweep authority and dispatches armed_recovery_requested through the reducer (wire-or-retire table above) |
| src/hooks/pr-workflow-gate.ts:settlePresumedStalePrWorkflowLanes | :4185 | sweepStaleDelegationsAsync (sweep authority) | scan | deliberate-second-authority | narrowed to pending/running with probe-retained exclusions (#2251); durability is best-effort once the in-memory decision stands |
| src/pr-review/completion.ts:<module> | :1557, :1844 | withSessionStateMutation / writeStateWhileLocked state snapshot | scan | routed | the coverage admission and its rollback writer: the state-snapshot admission class the census contract names, admitted under the session-state authority. #3312: inside the admission body, an ARMED overwrite supersedes an already-admitted disclosure only for the same dimension-tuple multiset (audited as `pr_review_coverage_disclosure_superseded`, with the superseded write restored when the state write fails), and admission is refused while contract retry budget remains — the retry-first order (AC10) |
| src/pr-review/verdict-settlement.ts:<module> | :404 | verdict-settlement store | scan | routed | #3101 durable verdict-settlement receipt persistence |
| src/tools/cancel-lane-batch.ts:executeCancelLaneBatch | :448 | settleDelegationTerminal | scan | routed | #2971 operator cancellation through the claim primitive with the operator_cancelled failure class |
| src/tools/complete-pr-workflow.ts:executeCompletePrWorkflow | :103 | settlePresumedStalePrWorkflowLanes (sweep authority) | scan | routed | tool-side completion entry point for the gate lane settlement |
| src/tools/dispatch-lanes.ts:appendAsyncLaneLaunchError | :4902, :4915, :4918 | settleDelegationTerminal; appendDelegationTransition | scan | routed | the launch failure settles through the claim primitive when the record exists; the never-landed arm has no record for a claim to act on yet still carries the typed terminal with null identity material (#2700) |
| src/tools/dispatch-lanes.ts:collectOnce | :3239, :3402, :3409 | settleDelegationTerminal; appendDelegationTransition CAS (stale) via buildTypedDelegationTerminal | scan | routed | a classified terminal error that produced no output settles as cancelled/error through the claim primitive (:3224). #3313 AC37: an idle lane whose full transcript window holds no assistant text settles as a liveness `stale` terminal immediately (:3359/:3363) instead of waiting the stale horizon — the CAS append carries the typed terminal with the liveness failure class and expectedCurrentStatuses pending/running |
| src/tools/dispatch-lanes.ts:runLane | :5858, :5904 | settleDelegationTerminal | scan | routed | blocking-lane success and failure terminals through the claim primitive, with the observation bundle |
| src/tools/dispatch-lanes.ts:settleCollectedLane | :4489, :4594 | settleDelegationTerminal | scan | routed | the main collection terminal path (contract-invalid and normal) through the claim primitive, after the receipt is attached |
| src/tools/dispatch-lanes.ts:settleCollectedLaneFromReceipt | :4005, :4012 | appendDelegationTransition (completed) via buildTypedDelegationTerminal | scan | deliberate-second-authority | #3312/#3313 AC28/AC29: a base/micro/council lane carrying an exactly-bound structured receipt settles completed from the receipt itself during collection; never routes through settleCollectedLane because that chain requires transcript evidence this shape does not have, so the typed completed terminal is appended under an expectedCurrentStatuses CAS with the receipt-bearing result (error/class dropped) |
| src/tools/dispatch-lanes.ts:sweepStaleAsyncLaneRecords | :5168, :5217, :5223 | settleDelegationTerminal; appendDelegationTransition CAS | scan | routed | an unobservable host settles through the claim primitive; the idle-host flip covers ingestion_error, which the claim refuses, under an expectedCurrentStatuses CAS carrying the typed terminal (#2615/#2700) |
| src/tools/write-pr-review-artifact.ts:executeWritePrReviewArtifact | :583, :698 | admitPrReviewPartialBaseCoverage / rollbackPrReviewPartialBaseCoverageAdmission | scan | routed | artifact-tool admission and rollback into the completion-module authority |
| src/pr-review (reducer dispatch sites) | n/a | reducePrReviewEvent | cross-reference | routed | censused by the wire-or-retire table above and `tests/unit/pr-review/reducer-adapter-authority.test.ts` |
| src/workflow/coder-settlement.ts | n/a | its own WAL state machine | cross-reference | routed | the #2214/#2402 DISPATCHED-wedge surface, pinned by `tests/unit/workflow/coder-settlement-2214.test.ts` |
| src/background/stage-b-dispatch-binding-store.ts | n/a | durable binding store | cross-reference | routed | the #2829 restart surface (PR #2883); fail-closed consumer `warnStageBSettlementDropped` in `src/hooks/delegation-gate.ts` |

### Wedge-shape layer map

The four historical settlement-wedge shapes and where this repository proves
them unreachable (properties in `tests/unit/pr-review/settle-invariants-2908.test.ts`
and the disk properties under `tests/unit/background/`; reproductions in
`tests/unit/pr-review/settle-wedge-shapes-2908.test.ts`):

- **#2214 — lane stays non-terminal after a terminal claim.** Incident
  surface: the coder-settlement WAL (`DISPATCHED` vocabulary; pinned by
  `tests/unit/workflow/coder-settlement-2214.test.ts`). This census pins the
  LEDGER layer's equivalent invariant: once `claimTerminalResult` records a
  terminal, no interleaving (duplicate replay, conflicting terminal, re-read)
  can leave the correlation folding to a non-terminal status, and a conflicting
  terminal is rejected and audited rather than overwriting.
- **#2402 / #2666 — a late older-generation result advances the task.**
  Load-bearing fences: the adapter's superseded-generation refusal, the
  durable publisher lock's `expectedWorkflowInstanceId/Revision` conflict, and
  the create-generation CAS. The properties pin the reducer's defense-in-depth
  fence (`stale_generation_result`); the reproduction exercises the publisher
  fence directly with a schema-valid receipt, so the fence is what decides.
- **#2840 — APPROVE with a disclosed degradation.** Incident surface IS the
  reducer: `degraded_disclosure_cannot_approve` (fix PR #2880) — pinned
  directly by property and reproduction.
- **#2829 — a terminal is lost on restart.** Incident surface: the Stage-B
  dispatch-generation binding store (PR #2883). The properties pin the
  ledger/checkpoint refold across real compaction; the reproduction also
  round-trips the binding store's restart reconstruction.

### Guardrail (census ratchet)

`tests/unit/pr-review/settle-admit-census-ratchet-2908.test.ts` re-runs this
census on every test run: every scanner identity has a row of the right class,
every row's cited hit lines equal the scanner's actual hit lines for that
identity, every disposition is a census token, no row is a `straggler`, and
every scanner pattern is non-empty. Disclosed boundaries (the census states the
same list): a dynamic-dispatch alias that no pattern names is invisible to a
text scanner, and a symlinked source entry is skipped rather than diagnosed.
A transition whose terminal status cannot be resolved statically is NOT a
boundary — it is inventoried, because the scan fails closed there.
