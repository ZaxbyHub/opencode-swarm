# Transactional task workflow recovery

- Coder attempts no longer create reviewer debt until a trusted settlement
  proves a non-empty mutation. Accepted mutations rotate exact-task workflow
  generations and invalidate stale Stage A/B evidence; Stage A failures enter a
  repairable `rework_required` state.
- Task status updates now validate the exact task before derived writes and
  mutate only the caller's task cache after the locked ledger/projection write.
  Settled-task reopen uses an ABA-safe, audited, idempotent PREPARED/COMMITTED
  repair record and can resume after interruption.
- The legacy `advanceTaskStateAndPersist` wrapper is now diagnostic-only: it
  refuses coder and terminal boundaries with
  `TASK_WORKFLOW_CENTRAL_TRANSACTION_REQUIRED` and never writes plan state.
- Completion recovery is capability-aware: exact-task repair, truthful spec
  reconciliation, critic approval, read-only work, exact ledger-projection
  reconvergence, and proven-disjoint tasks remain reachable without bypassing
  QA.
- Reviewer decisions now prefer durable exact-task generation evidence, and
  the persisted `critic_pre_plan` policy and balanced/strict planning profile
  are resolved consistently across save, runtime, prompts, and handoff output.
- Spec drift repair now verifies plan, snapshot, and idempotent audit state
  before deleting its marker; clarification mode alone is no longer described
  as clearing drift.
- Foreground coder work is fenced by a crash-recoverable settlement record:
  shared-root edits are attributed from a clean launch baseline, isolated
  worktrees use exact merge provenance, and landed code cannot bypass fresh QA
  debt when evidence publication or cleanup is interrupted.
- Identical background coder settlement replays are now idempotent only when
  their exact transition, outcome, and post-generation match; mismatched or
  stale replays still fail closed.
- Scope retirement installs its exact-generation deny before filesystem I/O,
  so a missing project root or failed durable cleanup cannot resurrect a live
  binding after the owning session ends.

## Migration and compatibility

- Normal task execution needs no migration. Integrations that manually reopen a
  settled task with bare `force: true` must now provide the audited repair
  reason, transition ID, expected settled status, and expected workflow
  generation.
- Existing plans without an explicit planning profile retain strict legacy
  behavior. New or unlocked plans may persist `balanced` or `strict`; locked
  plans cannot silently weaken their profile.
- Interrupted exact-task transactions can temporarily block that task while
  their WAL is recovered. Recovery is lazy and automatic on the next exact-task
  operation; corrupt or unverifiable records fail closed with repair guidance.
