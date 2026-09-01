# Unify Task and lane lifecycle with exactly-once terminals

## What

Resolves #2045 (Observability PR 17/23). Task-tool delegations and
`dispatch_lanes` lanes now share ONE lifecycle vocabulary over the existing
background-delegations ledger instead of two divergent terminal semantics.

Exactly-once terminals:
- Every lane terminal (async collect settle, cancel, classified terminal-error,
  transport-validation failure, async launch failure, and the blocking
  transport's success/failure/timeout) now settles through the shared
  `claimTerminalResult` operation via the new
  `src/background/delegation-lifecycle.ts` — the same exactly-once claim the
  Task completion observer uses. Durability across a crash between the claim
  and the observation pass: the AUTHORITATIVE receipts (ledger-committed ACK
  terminals, unacknowledged-critical violations, reviewer verdicts) re-run on
  settle replays — the receipt ledger is idempotent, so they close exactly
  once — while the DIAGNOSTIC observations (cost telemetry, trajectory, and
  the audit-only non-critical `unacknowledged` knowledge observation, which
  bypasses the ledger) are exactly-once-at-emit: the same crash window the
  Task transport's hook emissions have always had. Lane records gain the immutable
  `terminalResult` (eventId identity), duplicate replays return a benign
  `duplicate` disposition without re-running observations, and a conflicting
  event (e.g. a success arriving after a terminal cancel) is rejected and
  audited in the delegation-health `lateTerminals` counter — it can never erase
  the first terminal.
- A new `already_terminal_without_event` outcome distinguishes the benign
  stale-sweep/legacy-writer race from genuine event conflicts, so routine races
  do not pollute the audit.
- The 30-minute stale sweep remains a status-only presumption on both
  transports (documented transport-only difference); a lane wedged past it
  stays fenced exactly like a Task delegation.

Blocking-lane durability:
- Blocking `dispatch_lanes` dispatches now record a start record
  (`blocking:${sessionId}` callID, no `batchId`, so async-only surfaces stay
  async-only) and claim their terminal before the lane result returns. The
  start-record write is fire-and-forget so the delegation ledger's evidence
  lock never serializes concurrent lane prompt starts; a failed write fails
  open (the dispatch proceeds, with a visible log line).

Cost + trajectory parity:
- Lane terminals emit the `delegation_begin`/`delegation_end` cost-event pair
  with canonical identity digests (`parentSessionId\0callID\0lane:${laneId}` —
  joins by record fields, never agent-name matching) and append a trajectory
  observation carrying new additive `batchId`/`laneId`/`taskId` join keys on
  `TrajectoryEntry`.

Knowledge receipts for lane outputs (#2025 work items 3–4):
- Lane transcripts are now ACK-reconciled at settle: the proven-shown set comes
  from the receipt ledger's session-bound `delegate_directive` memberships
  (what the transform-path injector actually displayed), routed through the
  same shared validator core as the Task adapter
  (`reconcileShownDirectives` — one implementation, not a second). Unacknowledged
  criticals become `violated` + audit; non-criticals become neutral
  `unacknowledged` events; all lane receipts stay `delegate`-sourced
  (self-report, non-independent for promotion).
- Reviewer-role lanes additionally receive per-directive compliance
  adjudication: the transform path now splices the per-phase
  `<directives_to_verify>` block for reviewer agents only (in-place
  `output.messages.splice`, guarded against double delivery with the Task
  prompt-prepend path), and the settle reconciles `DIRECTIVE_COMPLIANCE`
  verdicts through the existing `reconcileReviewerVerdicts`.

Injection ceiling:
- The `<delegate_knowledge_directives>` block now obeys the configured
  `inject_char_budget` (default 2,000) with a hard 2,000-character cap
  (`DELEGATE_INJECT_HARD_CHAR_CAP`) on BOTH transports — previously the block
  rendered every capped entry regardless of size and could exceed 7,000 chars.

## Why

Task and lane delegations wrote terminals to the same ledger through different
primitives: the Task side claimed immutable terminal events (eventId identity,
duplicate/late dispositions, audit), while lanes used a bare status write with
none of those guarantees. Lane outputs were also fully outside the knowledge
learning loop (directives shown, receipts never closed), lane terminals
produced no cost/trajectory observations, and blocking lanes had no durable
lifecycle at all.

## Verification

- New suites: `delegation-lifecycle.test.ts` (disposition contract,
  exactly-once observations, cost identity),
  `dispatch-lanes-terminal-claim.test.ts`,
  `dispatch-lanes-blocking-lifecycle.test.ts`,
  `dispatch-lanes-lifecycle-parity.test.ts` (the Task/lane parity matrix across
  completed/error/cancelled), `delegate-inject-char-budget.test.ts`,
  `lane-knowledge-receipts.test.ts`, and
  `lane-injection-real-host-transform.test.ts` (real transform hook).
- All 64 existing dispatch-lanes suites, the background delegation suites
  (exactly-once, restart-reconstruction, checkpoint-crash, completion
  observer), and the delegate-ack/verdict/injector families pass unchanged.
- Ratchets updated: `LIFECYCLE_PAIR_INVENTORY` (delegation-lifecycle producer,
  1 begin / 1 end) and `TRAJECTORY_STORE_IMPORT_ALLOWLIST` (documented caller).
