# `fix(swarm)`: fail loud when a gate-bearing dispatch resumes a completed subagent child

## Summary

- Added a **`SWARM_CHILD_RESUME_UNTRACKABLE` guard** to the delegation gate's `toolBefore` (`src/hooks/delegation-gate.ts`): a canonical-role subagent dispatch that passes `sessionID` to RESUME a child session whose durable delegation record is already terminal is now rejected with an actionable message before the child launches. Previously such a dispatch was admitted, but the resumed round could never be durably tracked — the toolAfter path records a correlation conflict for the new callID and the completion observer rejects the follow-up terminal as a late terminal — so the verdict of the resumed round was **silently lost**.
- Guard scope is deliberately narrow: non-terminal (pending/running) records stay resumable (their single terminal is still consumable), lane/batch/PR-review records (`batchId`/`laneId`/`mode`/`workflowLane` set) are exempt because `dispatch_lanes` owns its own resume semantics, non-canonical agents never block, and an uncertain store read degrades open so a corrupt ledger cannot brick every dispatch.
- Added **"FRESH DISPATCH EVERY ROUND"** guidance to the `critic-gate` skill (`.opencode` + `.claude` mirrors, byte-identical): every CRITIC-GATE round — the first review and every re-review after NEEDS_REVISION or a material plan change — must launch a fresh critic child; never resume a prior critic child session.
- Regression coverage in `tests/unit/hooks/delegation-gate-resume-guard.test.ts` (7 tests, falsification-verified: the refusal tests fail with the guard removed).

## User-facing changes

On OpenCode 2.x native-async hosts, a model that resumes a completed swarm child session for a reviewer/critic/coder-style dispatch now gets an immediate, actionable rejection (`SWARM_CHILD_RESUME_UNTRACKABLE … omit the sessionID argument`) instead of a silently lost verdict that later wedges the workflow at `no_approved_snapshot` / `PLAN_CRITIC_GATE_VIOLATION`.

## Migration notes

None required. Dispatches that previously appeared to work (resume of a terminal child) were already broken downstream; they now fail at dispatch time with recovery instructions.

## Discovery context

Live failure in a consumer project (2026-11-21): a CRITIC-GATE re-review after NEEDS_REVISION resumed the same critic child session (the v2 host's subagent tool invites exactly this: "call subagent again with this sessionID"). The round-2 APPROVED verdict was never recorded (`get_approved_plan` → `no_approved_snapshot`, `.swarm/background-delegations-health.json` → `lateTerminals: 3`), EXECUTE was blocked by the `critic_pre_plan` gate, and the `approve_plan_critic` escape hatch returned NOT_AUTHORIZED because the orchestrator ran as the `build` agent instead of the swarm architect — a total deadlock requiring manual intervention.
