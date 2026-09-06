# Worktree lane dispatch: no more orphan child sessions after the session-create deadline (#2599)

## What changed

- **Configurable lane session-create budget.** New `worktree.session_create_timeout_ms`
  config knob (integer, 1000–120000, default **30000** — raised from the old hardcoded
  5000). On hosts where a fresh worktree lane's child-session init legitimately exceeds
  5 s (cold-FS plugin init: bundled-skill sync + repo-graph fingerprint + SQLite open),
  every worktree-isolated dispatch used to fail at the deadline. The deadline error now
  names the knob: `... deadline expired after Nms (worktree.session_create_timeout_ms)`.
- **Deterministic late-settle handling.** `createSessionWithinBudget` now captures the
  create promise's settle state in a derived settle-state promise instead of a racy
  boolean, so a create that settles after the deadline reaches teardown under every
  microtask interleaving, and lane cleanup never starts before the create settles (or a
  bounded 5 s settle grace expires).
- **Verified teardown.** New `teardownEphemeralSessionVerified`: bounded abort → delete →
  `session.get` existence check, bounded delete retries, and a typed
  `ephemeral-session-teardown-unverified` failure when the child survives. The old
  docstring claim that a leaked session "is harmless" is corrected — a leaked lane child
  holds the lane's `swarm.db` WAL lock.
- **Close-before-delete.** Every lane teardown path (dispatch-failure cleanup,
  pre-provision collision cleanup, dispatch cleanup, delegation-gate terminal failure,
  init orphan recovery, `/swarm reset-session`) now releases the lane's project-DB handle
  (`closeProjectDb`) before deleting the lane directory — the Windows WAL-lock ⇒ EBUSY
  failure class. An in-repo guardrail test fails if any of these sites regresses.
- **Typed strand diagnostics + deferred reclaim.** When a dead lane still cannot be
  removed (EBUSY), the failure now surfaces a typed, actionable
  `WORKTREE_LANE_STRANDED` diagnostic (exact path, holder guidance, "reclaim scheduled
  at next start") and records the lane in a bounded `.swarm/dead-lane-reclaims.json`
  store. The next plugin start reclaims it — ownership-checked (a lane whose parent
  session is active or that is protected by recovery records is never reclaimed) and
  dirty-gated (uncommitted work is preserved; #2508 interplay). `/swarm reset-session`
  reports the same diagnostic for lanes it could not remove.

## Why

On affected hosts every standard worktree-isolated coder dispatch failed at the 5 s
create deadline AND leaked the late-accepted child session; the child's plugin activity
held the lane's `swarm.db` WAL lock, making the lane directory undeletable (EBUSY) and
wedging the plan task until a full host restart (issue #2599, double live reproduction).

## Known limitations

- Lean-turbo lanes (`src/turbo/lean/runner.ts`) retain their prior teardown behavior:
  their DB handles are owned by separately spawned child processes, which the interrupt
  path kills. The lane-liveness work (#2598 / #2506) is the follow-up surface.
- `/swarm reset-session` and init orphan recovery enumerate the default
  `.swarm-worktrees/` layout only; lanes provisioned under a configured `worktree_dir`
  override live elsewhere and are not handle-closed by these two paths (tracked with
  #2527's shared reclamation surface).

## Coordination

- Landing before #2596 (provable-non-acceptance failover) and #2598 (lane-liveness
  watchdog) so retry/watchdog inherit the corrected late-settle semantics, per the
  issue's merge-order note.
