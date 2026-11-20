# Async subagent lifecycle — architecture map (OpenCode 2.3 native async)

> Status: living document (r11+). This map describes how a `Task` delegation
> travels from dispatch to terminal settlement, which side effects run on the
> **synchronous** `tool.execute.after` path, which run on the **native
> asynchronous** completion path, and where the two paths diverge. It is the
> reference for repairs r11–r13 (findings F1–F6 of the async lifecycle audit).

## 1. Participants

| Module | Responsibility |
| --- | --- |
| `src/host/v2/events.ts` | v2 event pump. Maps host events onto v1 handler inputs. `session.inbox.enqueued` / `session.synthetic` (verified subagent notices) become synthetic `message.part.updated` text parts; `session.tool.progress` seeds child identity; `session.step.ended` becomes usage step-finish parts (r8 bridge). |
| `src/host/v2/native-async-mode.ts` | Bounded registry of host-verified native child sessions (`rememberVerifiedNativeChild`, `verifiedNativeChildParent`, `isTrackedNativeChildSession`). |
| `src/host/v2/usage-bridge.ts` | Durable per-step usage aggregation by child session id; idempotent per host event id; consumed exactly once by the Task handoff. |
| `src/index.ts` (`event` hook) | Fan-out of every mapped event: PR-workflow session resolver → `prWorkflowResponseGate.event` → PR idle delivery → `backgroundCompletionObserver.event`. |
| `src/index.ts` (`tool.execute.after`) | Synchronous Task-completion side effects: hook chain (knowledge curator, snapshot writer, summarizer, …), context-map update, Task handoff (delegation begin/end telemetry, cost fields, pipeline advisories, sounding-board verdict policy). |
| `src/hooks/delegation-gate.ts` | Dispatch-time admission (gates, scope, worktree provisioning, plan-critic gate), background pending-delegation recording, and the synchronous settlement path (coder settlement, merge-back, critic approval snapshot, sounding-board recording). |
| `src/background/pending-delegations.ts` | Durable delegation ledger (`.swarm/background-delegations.jsonl` + SQLite coordination). `BackgroundDelegationRecord` is the launch identity: `(correlationId = child session id, parentSessionId, callID, agent)`. Terminal claims (`claimTerminalResult`) are exactly-once per immutable `eventId`. |
| `src/background/completion-observer.ts` | Trusted-terminal consumer for native async completions: identity verification → terminal claim → maintenance → role-specific settlement (coder settlement/worktree, Stage-B ingestion, docs phase participation, epic residue) → advisory publication. |
| `src/background/stage-b-gates.ts` | `ingestBackgroundStageBCompletion`: reviewer/test_engineer verdict parsing, route-receipt enforcement, reviewer receipt collection, gate evidence, task state advancement. Also classifies gate-bearing records (incl. `critic`). |
| `src/background/delegation-lifecycle.ts` | Shared `settleDelegationTerminal()` (lanes): terminal claim + `delegation_end` cost observation + execution attempt + trajectory + knowledge receipt reconciliation. |
| `src/plan/ledger.ts` | Plan ledger. `takeSnapshotEvent(source: 'critic_approved', approvalMetadata {source: 'plan_critic_gate', …})` writes the plan-critic approval snapshot; `loadLastPlanCriticApprovedSnapshot` + `approvedSnapshotCoversPlan` verify it against the current plan's structural hash. |

## 2. Dispatch — how a native async Task launch is durably tracked

1. Architect calls `task` (`subagent_type`, `prompt`, …). `tool.execute.before`
   (delegation gate) runs admission: gates, scope binding, plan-critic gate
   (`assertPlanCriticApprovedForExecution` for coder dispatches), worktree
   provisioning, coder reservations, and emits `delegation_begin` telemetry.
2. OpenCode 2.3 returns a **running placeholder** (`state: 'running'` /
   `metadata.background === true`) instead of the child result.
3. `tool.execute.after` (delegation gate) detects the placeholder
   (`outputLooksLikeBackgroundRunning`), extracts the child session id
   (`extractDispatchIds`), and records a durable pending delegation via
   `recordPendingDelegationDetailed` (identity: correlation/parent/call/agent,
   workspace snapshot, prompt snapshot, optional worktree/reservation).
4. The v2 pump observes `session.tool.progress` for the subagent tool call and
   registers the host-verified `(child → parent)` identity
   (`rememberNativeChildFromProgress` → `rememberVerifiedNativeChild`).
5. The Task handoff in `src/index.ts` restores architect identity and —
   because the result is a running placeholder — **defers** completion
   telemetry/advisories to "the trusted terminal event".

## 3. Completion — the trusted terminal path

1. Host emits `session.inbox.enqueued` (or SDK `session.synthetic`) with a
   `<subagent sessionID=… state=…>` wrapper. `mapV2NativeSubagentCompletion`
   converts ONLY host-labelled, structurally consistent notices for a
   host-verified child of the exact receiving parent into a synthetic v1 text
   part (reusing `renderV1TaskEnvelopeFromV2`, including truncation/escaping).
2. `src/index.ts` `event` hook fans out (order): `prWorkflowSessionResolver`,
   `prWorkflowResponseGate.event`, PR idle delivery, then
   `backgroundCompletionObserver.event`.
3. The observer parses the task envelope, requires a terminal state
   (`completed`/`error`/`cancelled`), looks up the durable delegation by child
   session id, **verifies identity** (parent + child match the record), claims
   the terminal exactly-once (`claimTerminalResult`, immutable `eventId` from
   correlation + status + result digest), then runs role-specific processing:
   - `error`/`cancelled`: route-retirement flush, coder retry accounting /
     reservation release / worktree abort, advisory.
   - `completed` + `coder`: `settleCoder` (shared-root attribution or worktree
     merge-back via `finishStandardWorktreeDispatch`, with durable settlement
     provenance and idempotent replay).
   - `completed` + gate-bearing roles: Stage-B workspace freshness check +
     `claimDelegationIngestion` + `ingestBackgroundStageBCompletion`.
   - `docs`: phase participation; non-coder epic writers: residue commit.
4. Durable advisories are published per terminal event id
   (`putPendingBackgroundAdvisory`) and delivered to the parent session.

Crash recovery: `maintainBackgroundDelegations` (session-close, terminal
maintenance points P2/P2b) and `reconcilePending` replay a claimed-but-
unconsumed record through the same `event()` entry — every transition is
resumable, and the terminal claim deduplicates replays.

## 4. Side-effect parity matrix (sync `tool.execute.after` vs async observer)

| Terminal side effect | Sync path | Async (observer) path | Finding |
| --- | --- | --- | --- |
| Coder settlement / merge-back | delegation-gate after-hook | `settleCoder` (idempotent, durable) | ✅ |
| Stage-B ingestion (verdicts, route receipts, reviewer receipts, gate evidence, state advancement) | delegation-gate after-hook | `ingestBackgroundStageBCompletion` | ✅ |
| Docs phase participation | after-hook | `completeBackgroundPhaseParticipation` | ✅ |
| Epic residue commit (non-coder) | after-hook | `commitEpicResidueAfterDelegation` seam | ✅ |
| Reviewer scope discard | after-hook | `discardScopeForRecord` | ✅ |
| Parent advisory publication | after-hook | durable advisory inbox | ✅ |
| **Plan-critic approval snapshot** (`recordPlanCriticApprovalSnapshotIfApplicable`) | after-hook | shared recorder `src/plan/critic-approval.ts` + dispatch-time binding (`planCriticDispatch`), replay-fenced by call id | ✅ r11 |
| **Context-map post-agent update** | after-hook (r12: skipped for running placeholders) | observer closeout on fresh claim, feature-gated | ✅ r12 |
| **Sounding-board verdict policy** (`applySoundingBoardResponsePolicy` + advisory) | after-hook | shared policy module `src/agents/sounding-board-policy.ts` + observer closeout | ✅ r12 |
| **`delegation_end` telemetry + cost identity + execution attempt** | Task handoff (skipped for running placeholders) | observer closeout via `emitTaskDelegationTerminalEnd` (fresh claim only; lanes stay on `settleDelegationTerminal`) | ✅ r12 |
| Pipeline continuation advisory (reviewer/test_engineer/critic) | Task handoff | observer closeout (fresh claim only) | ✅ r12 |
| Knowledge receipt reconciliation (lane parity) | lane collector | `reconcileDelegationKnowledgeReceipts` (ledger-idempotent, replay-safe) | ✅ r12 |
| Usage/cost accounting | r8 usage bridge + `consumeAssistantUsageForTask` at handoff | bridge accumulates; consumption happens at the placeholder handoff (dispatch time) | F4 (cost) |
| **Event fan-out isolation** | n/a | per-consumer isolation (`dispatchEventConsumerIsolated`, r13) | ✅ r13 |
| Knowledge ACKs / micro-reflection / auto-review | after-hook chain | section 8 matrix (ACKs ✅ r12; micro-reflector documented gap; auto-review n/a) | ✅ audited |

## 5. Security invariants of the async completion path

These are the properties every change to this area must preserve:

1. **Host-verified provenance only.** A terminal result is only accepted from
   a host-labelled subagent notice whose `(child, parent)` pair matches the
   pump's verified-native-child registry AND the durable delegation record.
   Model text, ordinary synthetic messages, wrong-parent notices, and
   unverified tool events never produce a terminal.
2. **Exactly-once terminal claim.** `claimTerminalResult` with the immutable
   `eventId` (correlation + status + result digest) is the single authority;
   a different result for the same correlation is a conflict, and replays of
   the same result are duplicates that resume — never re-run — completed
   transitions.
3. **Identity binding.** Every side effect keys on the durable record's
   `(parentSessionId, subagentSessionId, callID, normalizedAgent)`; nothing is
   attributed from ambient session state alone.
4. **Fail-closed approvals.** An approval (plan-critic snapshot, sounding
   board gate entry) may only originate from a successfully completed,
   host-verified child whose dispatch was bound at dispatch time; failures,
   cancellations, unparseable verdicts, and identity mismatches never approve.
5. **Staleness fences.** Worktree/workspace identity is re-checked after every
   await gap before ownership maps are touched; the plan-critic approval must
   cover the *current* plan structure (`computePlanStructureHash`).
6. **No duplicated settlements.** Coder settlement, merge-back, Stage-B
   ingestion, cost records (deterministic `record_id` /
   `identity_fingerprint`), and advisories are idempotent or claim-guarded;
   replays after crash/restart must not double-execute them.
7. **The r8 usage bridge must not be bypassed or double-billed.** Step usage
   is aggregated per child session by host event id and consumed exactly once;
   async terminal handling must not fabricate a second cost record for the
   same steps.

## 6. Open questions resolved by r11–r13

- **r11 (F1):** where does the async approval snapshot come from, and how is
  it bound to the plan the critic actually reviewed? → Dispatch-time
  classification + plan-structure hash on the delegation record; completion-
  time verification; ledger-level dedup by `call_id`; the existing
  `takeSnapshotEvent` API stays the single write choke point.
- **r12 (F2/F3/F4):** the durable `BackgroundDelegationRecord` +
  `BackgroundTerminalResult` already carry the full typed terminal identity
  (parent/child/call/role/status/eventId/result/dispatch binding), so no
  second closeout DTO was introduced. Instead the observer gained a shared
  business-closeout block keyed on that identity: exactly-once-at-emit effects
  (context map, sounding-board verdict, pipeline advisory, `delegation_end`)
  run only on the FRESH terminal claim (`isFreshTerminalClaim` — stricter than
  `!isDuplicate`, which a `retry_ingestion` redelivery would slip past); the
  ledger-idempotent knowledge reconciliation runs on every delivery with the
  replay flag. Lane records are excluded (they settle through
  `settleDelegationTerminal`), so nothing double-books.
- **r13 (F5/F6):** fan-out isolation (a failing sibling consumer must not
  starve the durable completion observer, visibly), and a completeness audit
  of every terminal-bound after-hook action. Both delivered: F5 isolates each
  event consumer behind `dispatchEventConsumerIsolated` (deferred-warning
  surfacing, per-consumer cooldown); F6's matrix is section 8 below.

## 7. Terminal consumers (business closeout), by transport

| Consumer | Sync `tool.execute.after` | Async observer | Notes |
| --- | --- | --- | --- |
| Plan ledger approval snapshot | `recordPlanCriticApprovalSnapshotIfApplicable` | r11 | Gate: `assertPlanCriticApprovedForExecution` (coder dispatch), policy `critic_pre_plan` |
| Context map | `updateContextMapAfterAgent` | r12 | Feature-gated `context_map.enabled` |
| Sounding board verdict | `applySoundingBoardResponsePolicy` | r12 | Escalation events `sounding_board_consultation` are recorded in the before-hook; manual escape hatch `approve_retry_sounding_board` |
| Delegation telemetry | `telemetry.delegationBegin/End` | r12 (parity with `delegation-lifecycle.emitDelegationCostObservation`) | Lanes already pair via `settleDelegationTerminal` |
| Cost correction | `trackPendingCostCorrection` + late-step upgrade | r12 (no double billing; bridge stays the usage authority) | Deterministic `record_id` dedups rollups |
| Knowledge receipts | lane: `reconcileLaneKnowledgeReceipts`; Task: transform-path scans | r12 | Ledger-idempotent, replay-safe |
| Stage-B / reviewer receipts | after-hook | `ingestBackgroundStageBCompletion` | claim-guarded |
| Coder settlement / worktree | after-hook | `settleCoder` | claim-guarded, durable provenance |

## 8. F6 completeness audit — every terminal-bound after-hook action (r13)

Legend: **sync** = `tool.execute.after` path; **async** = native-async
completion path (background completion observer unless noted). "n/a" = not
delegation-terminal-bound (runs at another boundary by design).

| Closeout action | Sync path | Async path | Verdict |
| --- | --- | --- | --- |
| Coder settlement / merge-back / reservation release | delegation-gate after-hook | `settleCoder` + release (observer) | ✅ claim-guarded |
| Stage-B ingestion (verdicts, gate evidence, task state) | after-hook | `ingestBackgroundStageBCompletion` (stage-b-gates) | ✅ |
| Reviewer receipts (`collectReviewerReceiptFromTranscript`) | after-hook | stage-b-gates ingestion (reviewer arm) | ✅ |
| Review-route receipt enforcement | after-hook | stage-b-gates (sites A–D) | ✅ |
| Docs phase participation | after-hook | `completeBackgroundPhaseParticipation` (observer) | ✅ |
| Epic residue commit (non-coder writers) | after-hook | `commitEpicResidueAfterDelegation` seam (observer) | ✅ |
| Reviewer/coder scope discard | after-hook | `discardScopeForRecord` (observer) | ✅ |
| Parent advisory publication | after-hook | durable advisory inbox (observer) | ✅ |
| Plan-critic approval snapshot | after-hook | shared recorder + dispatch binding (r11) | ✅ |
| Context-map post-agent update | after-hook (r12: gated on non-placeholder) | observer closeout (r12) | ✅ |
| Sounding-board verdict policy + advisory | Task handoff | shared policy module (r12) | ✅ |
| `delegation_begin`/`delegation_end` telemetry pair | toolBefore / Task handoff | toolBefore / `emitTaskDelegationTerminalEnd` (r12; lanes via `settleDelegationTerminal`) | ✅ |
| Execution-attempt records | Task handoff / lane observations | `emitTaskDelegationTerminalEnd` (r12) | ✅ |
| Knowledge ACK receipts (`collectDelegateAcksAfter`) | after-hook | `reconcileDelegationKnowledgeReceipts` (r12; ledger-idempotent) | ✅ |
| Reviewer DIRECTIVE_COMPLIANCE verdicts (`collectReviewerVerdictsAfter`) | after-hook | `reconcileReviewerVerdicts` via the same reconciliation (r12) | ✅ |
| Pipeline continuation advisory | Task handoff | observer closeout (r12) | ✅ |
| PR-workflow response gate / session resolver / idle delivery | event hook | same event hook, r13 isolation | ✅ (F5) |
| Event fan-out isolation | n/a | per-consumer isolation (r13) | ✅ (F5) |
| Auto-review (task_completion trigger) | `update_task_status` toolAfter (architect action) | n/a — not delegation-terminal-bound | ✅ n/a |
| Session reflection | `/swarm close` finalize stage | n/a | ✅ n/a |
| Usage/cost accounting | r8 usage bridge + handoff consumption | bridge accumulates per child session | ⚠️ see below |
| Micro-reflector (insight candidates on failed/partial delegates) | after-hook (`microReflectorAfter`) | **gap** | ⚠️ documented |
| Trajectory completion marker for the delegation | trajectory logger (tool-call record) | dispatch-time record only | ⚠️ documented |
| Snapshot writer / tool summarizer / knowledge curator / compaction / repo-graph / spiral detection | per-tool-call hooks | run at dispatch on the placeholder (their designed boundary — they are tool-call hooks, not completion hooks) | ✅ by design |

### Documented, deliberate non-ports (with rationale)

- **Usage attribution for async children**: the r8 usage bridge aggregates
  each child session's per-step usage (idempotent by host event id), but no
  consumer currently drains the child's total into a `delegation_end` cost
  record on the async path — the r12 end emission is unknown-honest about cost
  axes. Nothing is double-billed (the bridge is neither bypassed nor
  re-counted), but async delegation cost evidence is thinner than sync. A
  future fix should drain the bridge total at the observer's terminal (the
  consumption seam lives in src/index.ts) rather than fabricating estimates.
- **Micro-reflector**: quota-gated, enrichment-only insight-candidate
  generation on delegate failure/partial returns. No gate, settlement, or
  state machine depends on it, and porting it means wiring the curator LLM
  delegate into the observer. Left as a documented gap; the durable learning
  append remains the crash backstop for the sync path.
- **Trajectory completion marker**: sync Task completions appear in the
  trajectory as the tool-call record; async dispatches record the placeholder
  call at dispatch time. Adding a completion entry would introduce a shape
  with no sync twin; deferred until a consumer needs it.
