# OpenCode 2.3 Native-Async Lifecycle: Verified Completions, Approvals, and Closeout Parity

## What

Repairs the native-async subagent lifecycle (OpenCode 2.3 background
subagents) end to end, closing audit findings F1–F6: verified plan-critic
approvals on async completions, correct context-map semantics, sounding-board
and telemetry parity, event fan-out isolation, and a full completeness audit
of terminal-bound actions. Includes the verified r5–r10 OpenCode 2.3
compatibility checkpoint (child-session identity, completion/inbox bridge,
usage events, tool/text adapters, guarded task completion).

Plan-critic approvals (F1):
- A critic child dispatched natively async that returned `VERDICT: APPROVED`
  now records its approval snapshot automatically. Previously the snapshot
  was written only by the synchronous Task path, so the next coder dispatch
  was blocked with `PLAN_CRITIC_GATE_VIOLATION` and required the manual
  `approve_plan_critic` escape hatch.
- One shared approval implementation (`src/plan/critic-approval.ts`) serves
  both transports. Plan-critic dispatches are bound at dispatch time to the
  plan's structural hash (durable `planCriticDispatch` field), so a plan
  edited after the dispatch can never be approved by the old verdict. The
  ledger dedups approvals by call id — replays and crash recovery can never
  approve twice. Failed/cancelled children, wrong identities, and
  unparseable verdicts fail closed.

Context map (F2):
- Starting a native-async child no longer writes a `final_status` summary the
  moment it launches (the running placeholder was misread as a completion).
- A verified async completion now writes the same context-map summary the
  synchronous handoff writes (same feature flag, same mapping); failures and
  cancellations never appear as success.

Sounding board + pipeline (F3):
- Async `critic_sounding_board` completions are evaluated by the exact same
  verdict policy as the sync handoff (`src/agents/sounding-board-policy.ts`);
  unparseable responses surface the treat-as-REPHRASE warning, never a silent
  approval. Pipeline continuation advisories now fire for async
  reviewer/test_engineer/critic/critic_sounding_board completions.

Telemetry + knowledge (F4):
- Native-async Task terminals now close their `delegation_begin`/
  `delegation_end` pair (success, failure, and cancellation) with the
  deterministic Task-shape cost identity, and reconcile knowledge receipts
  (ledger-idempotent, replay-safe). Lane records keep their existing
  `settleDelegationTerminal` path — nothing is double-booked, and the r8
  usage bridge remains the usage authority.

Event fan-out (F5):
- Each independent event consumer (PR-workflow resolver/gate, PR idle
  delivery, terminal-session handling, and the durable background completion
  observer) is now isolated: a throwing sibling can no longer starve the
  completion observer, and failures surface through the operator-visible
  deferred warning buffer with a per-consumer cooldown.

Completeness audit (F6):
- Every terminal-bound after-hook action is mapped to its sync and async
  path in `docs/architecture/async-lifecycle.md` (section 8), with the
  deliberate non-ports documented (async cost draining, micro-reflector,
  trajectory completion marker).

## Why

A live architect–critic–coder run on OpenCode 2.3 wedged on
`PLAN_CRITIC_GATE_VIOLATION` after the critic APPROVED, because the approval
snapshot only existed on the synchronous path. The broader audit showed the
same transport asymmetry across context map, sounding board, telemetry, and
event fan-out — native-async completions ran the durable settlement machinery
but none of the business closeout, and one failing event consumer could
silently suppress completion processing entirely.

## Verification

- New focused suites: `critic-approval` (8), observer plan-critic approval
  (9), terminal closeout (11), fan-out isolation (5), context-map placeholder
  (2), async lifecycle integration matrix (9).
- Full background (172 files), delegation-gate (127 files), plan, index,
  context-map, observability, and host/v2 suites pass per-file isolation;
  `tsc --noEmit`, `bun run build`, and `drift:check` are clean.
