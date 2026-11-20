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
| **Plan-critic approval snapshot** (`recordPlanCriticApprovalSnapshotIfApplicable`) | after-hook | **MISSING** | **F1** |
| **Context-map post-agent update** | after-hook (runs even for running placeholders, writing `final_status: 'completed'` at dispatch time) | **MISSING on real completion** | **F2** |
| **Sounding-board verdict policy** (`applySoundingBoardResponsePolicy` + advisory) | after-hook | **MISSING** | **F3** |
| **`delegation_end` telemetry + cost identity + execution attempt** | Task handoff (skipped for running placeholders) | **MISSING** (observer claims terminal directly, never emits the pairing end) | **F4** |
| Pipeline continuation advisory (reviewer/test_engineer/critic) | Task handoff | missing (covered by r12 closeout) | F3/F4 |
| Knowledge receipt reconciliation (lane parity) | lane collector | Task records bypass `settleDelegationTerminal` (no reconciliation) | F4 |
| Usage/cost accounting | r8 usage bridge + `consumeAssistantUsageForTask` at handoff | bridge accumulates; consumption happens at the placeholder handoff (dispatch time) | F4 (cost) |
| **Event fan-out isolation** | n/a | one try/catch around the whole fan-out: a throwing `prWorkflowResponseGate.event` prevents the observer from ever seeing the completion | **F5** |
| Knowledge ACKs / micro-reflection / auto-review | after-hook chain | audited in r13 (F6) | F6 |

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
- **r12 (F2/F3/F4):** a shared, typed terminal closeout record so context-map,
  sounding-board, telemetry and knowledge reconciliation run exactly once on
  the verified async completion — without duplicating coder settlement,
  worktree merge-back, or Stage-B (which stay claim-guarded in the observer).
- **r13 (F5/F6):** fan-out isolation (a failing sibling consumer must not
  starve the durable completion observer, visibly), and a completeness audit
  of every terminal-bound after-hook action.

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
