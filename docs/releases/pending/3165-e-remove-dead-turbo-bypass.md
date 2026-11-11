# Fix: Turbo checks no longer leak across sessions; dead Stage B bypass removed

## What

`checkReviewerGate` (`src/tools/update-task-status.ts`) still carried two
branches that let Turbo Mode and Lean Turbo skip Stage B: a Lean Turbo branch
for a task in a completed lane, and a Turbo branch for a task whose
`files_touched` contain no Tier 3 path. They ran only when the caller passed
neither a session id nor a fallback directory, and then checked Turbo with no
session, which means "any session has Turbo on". Completion never relied on
them: the locked check under the plan lock always passes a fallback directory
and applies the same Stage B rule in every mode.

They did have one visible effect. Without a session id, the pre-lock check
passed no fallback directory, so it could admit a completion that the locked
check then refused with a `TASK_COMPLETION_CAS_MISMATCH` error instead of the
normal "Gate check failed: required QA gates not yet satisfied" result.

- Both branches are removed, together with
  `src/turbo/lean/task-completion.ts` (`verifyLeanTurboTaskCompletion`), which
  had no other caller.
- The pre-lock check now passes the same fallback directory as the locked
  check, so both reach the same decision. A refused completion without a
  session id now reports the normal gate failure with the exact-task reason
  (for example "Task X has no exact-task QA evidence. Delegate the required
  Stage B agents, then retry completion." when there is no evidence at all).
- The reviewer-gate telemetry reason codes `lean_turbo_completed_lane` and
  `standard_turbo_non_tier3` are no longer emitted and are removed from
  `ReviewerGateReasonCode`. Older `telemetry.jsonl` rows may still contain
  them.

`completion_verify` had the same "any session" leak. Its Turbo bypass called
`hasActiveTurboMode` with no session id, and the `phase_complete` completion
gate never passed one, so one session's `/swarm turbo` let another session's
`phase_complete` skip completion verification. Now:

- The bypass applies only to an explicit session that has Turbo on.
- The `phase_complete` gate passes its session id.
- The `completion_verify` tool takes the session from the plugin context
  before a session id supplied in its arguments.

Turbo Mode still skips the Stage A re-delegation block for non-Tier-3 tasks
(`src/hooks/delegation-gate.ts`); that is unchanged. `hasActiveTurboMode()`
without a session id still means "any session" for `/swarm status` and
`epic start`, which use it on purpose, and for the system-prompt Turbo banner
when a hook input carries no session id (advisory text only). Neither Stage B
nor completion verification reaches it any more.

## Migration

None. Stage B was already required at completion in every mode.

`completion_verify` now runs the verification whenever the CALLING session
does not have Turbo on, even while another session does. That includes a call
with no session id, and a call from an agent session (for example
`critic_oversight`) while only the architect's session has Turbo on: such calls
were previously bypassed and can now block.

## Known caveat

A completion call without a session id that previously failed under the plan
lock with `TASK_COMPLETION_CAS_MISMATCH` now fails earlier with the normal
gate message. Anything that matched on that error text for this case should
match the gate message instead.
