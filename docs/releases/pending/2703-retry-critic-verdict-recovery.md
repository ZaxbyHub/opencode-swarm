# coder retry circuit-breaker gate: recovery tool for an obtained sounding-board APPROVED verdict + truthful reset-session footer

## What

Closes an unrecoverable blocked state in the coder retry circuit breaker's
`critic_sounding_board` gate (issue #2703). When a task's coder dispatch was
rejected three times in one retry epoch, `enforceCoderRetryEscalation`
required a durable `critic_sounding_board` APPROVED verdict before admitting
one final bounded retry — but the only writer of that verdict was the
mechanical toolAfter recorder, whose conjunctive preconditions (verdict
parsing through the plan-critic rubric, dispatch-time task attribution,
launch-generation binding, non-terminal output state) can each miss on a
legitimate APPROVED output. Notably, the sounding board's own instructed
RESPONSE FORMAT line (`Verdict: UNNECESSARY | REPHRASE | APPROVED | RESOLVE`)
is structurally unparseable by that rubric. Once any precondition missed,
every subsequent coder dispatch for the task was blocked with
`TASK_RETRY_CRITIC_REQUIRED: ... is waiting for an exact-generation
critic_sounding_board APPROVED verdict` — across sessions and resets — and
the only workaround was re-planning the task under a fresh id. The sibling
`critic_pre_plan` gate received exactly this escape hatch in #2012; the
retry gate never did.

Two faults are fixed:

1. **No recovery path.** This adds:
   - a `forceRecordRetrySoundingBoardApproval` hook
     (`src/hooks/delegation-gate.ts`) that writes the exact
     `gates.critic_sounding_board` evidence entry the mechanical recorder
     would have written (same `gate_recorded` transition, same retention
     semantics), gated on an active architect session, a plan-known task id,
     existing durable workflow evidence, and a prior durable
     `sounding_board_consultation` escalation for the task's CURRENT retry
     epoch — it records evidence only and never emits consultation /
     simplification / user-escalation events, so it cannot fabricate or skip
     the escalation protocol;
   - an `approve_retry_sounding_board` tool (architect-callable, registered
     through the metadata/manifest/index chain) requiring a `task_id` and an
     audited `reason`;
   - a new `sounding_board_manual_approval` action value on the
     `coder_retry_circuit_breaker` authority event, deduped per
     (task, retry epoch), so a manual override is distinguishable from a
     mechanical recording in `.swarm/events.jsonl`. A corrupt authority
     index surfaces as a typed `APPROVE_RETRY_AUDIT_INDEX_UNREADABLE` with
     repair guidance instead of wedging the recovery path.

2. **Misleading reset claim.** `/swarm reset-session` ended with
   `**All circuit breakers and revision limits have been cleared.**` while
   deliberately preserving `.swarm/events.jsonl` and `.swarm/evidence/` —
   the durable retry gate survived the reset the message claimed to clear.
   The footer now says in-memory state was cleared, that durable per-task
   retry gates intentionally survive, and names
   `approve_retry_sounding_board` as the recovery for a task blocked
   waiting for an already-obtained verdict.

## Why

A legitimately-approved, narrowly-scoped rework was reportable as blocked
for an entire session, requiring a structural plan mutation (task re-id) to
unblock — extra ceremony, an extra critic-gate re-approval, and extra audit
surface, purely because the approved verdict had nowhere to be recorded.
The retry breaker's cross-session durability is intentional and unchanged;
what was missing was the audited, identity-bound way to record a verdict
the mechanical recorder lost.

## Impact

- Wedged tasks become recoverable in place: one `approve_retry_sounding_board`
  call (with a reason) and the next coder dispatch passes the critic check,
  admitting the same single bounded simplified retry the mechanical path
  admits. The escalation sequence, retry thresholds, and generation/epoch
  retention semantics are untouched; a manual entry is cleared by
  `accepted_mutation`/`repair_idle` exactly like a mechanical one.
- `/swarm reset-session` behavior is unchanged; only its closing message now
  tells the truth about what survives.

## Migration steps

None. Existing evidence files and events are read as-is; the new action
value is ignored by pre-fix readers through the closed-set filters. Once
upgraded, have the architect call `approve_retry_sounding_board` with the
wedged task's id and a reason. The tool binds to the task's current
durable retry epoch — the analog of the issue's suggested "exact task id
+ generation" binding, since the gate's own waiting condition is
epoch-scoped (`enforceCoderRetryEscalation` reads escalations by
task + retry epoch).

## Drawbacks

- The manual path trusts the architect's stated reason; the
  `sounding_board_manual_approval` audit event (with the bounded reason) is
  the review surface for that trust, mirroring the #2012 precedent.
