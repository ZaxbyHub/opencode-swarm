---
name: critic-gate
description: >
  Full execution protocol for MODE: CRITIC-GATE -- plan critic review, revision loops, and hard stop before execution.
---

# Critic Gate Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: CRITIC-GATE
Delegate plan to the active swarm's critic agent for review BEFORE any implementation begins.
- Send the full plan.md content and codebase context summary
- **APPROVED** → Proceed to MODE: EXECUTE
- **NEEDS_REVISION** → Revise the plan based on critic feedback, then resubmit (max 2 cycles)
- **REJECTED** → Inform the user of fundamental issues and ask for guidance before proceeding

⛔ HARD STOP — Print this checklist before advancing to MODE: EXECUTE:
  [ ] the active swarm's critic agent returned a verdict
  [ ] APPROVED → proceed to MODE: EXECUTE
  [ ] NEEDS_REVISION → revised and resubmitted (attempt N of max 2)
  [ ] REJECTED (any cycle) → informed user. STOP.

You MUST NOT proceed to MODE: EXECUTE without printing this checklist with filled values.

CRITIC-GATE TRIGGER: Run ONCE when you first write the complete .swarm/plan.md.
Do NOT re-run CRITIC-GATE before every project phase.
If resuming a project with an existing approved plan, CRITIC-GATE is already satisfied.

6j. SPEC-GATE (Execute BEFORE any save_plan call):
- The save_plan tool will REJECT if .swarm/spec.md does not exist (enforced at the tool level via SWARM_SKIP_SPEC_GATE env var bypass).
- Before calling save_plan, verify spec.md is present using lint_spec.
- If spec.md is absent: do NOT call save_plan. Use /swarm specify to create a spec first, or inform the user.
- This rule is satisfied by the save_plan tool's own spec gate — it exists as a reminder that planning requires a spec.

6k. SPEC-STALENESS GUARD:
- If _specStale or .swarm/spec-staleness.json exists, the Architect MUST stop
  and SURFACE THE DRIFT TO THE USER. The user (not the Architect) then runs
  either:
  - /swarm clarify to update the spec and align it with the plan, OR
  - /swarm acknowledge-spec-drift to acknowledge the drift and suppress further warnings
- The Architect MUST NOT run /swarm acknowledge-spec-drift itself — not via
  the swarm_command tool, not via the chat fallback, and NOT by shelling out
  to `bunx opencode-swarm run acknowledge-spec-drift` (or any equivalent
  `npx`/`node`/`bun` invocation). Any such self-invocation is a
  control-bypass and will be refused by the runtime guardrails.
- Do NOT proceed with implementation until the user resolves the staleness.
- When re-saving a plan in response to spec drift, save_plan REQUIRES that ANY task
  present in the prior plan but absent from the new args.phases be enumerated
  in removed_task_ids with a removal_reason. save_plan will reject the call
  otherwise (PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED). Tasks not yet finished
  (status: pending, in_progress, blocked) MUST NOT be removed without explicit
  user confirmation — surface the list to the user and ask before populating
  removed_task_ids.
- While .swarm/spec-staleness.json exists, the runtime STRUCTURALLY BLOCKS the
  following tools (SPEC_DRIFT_BLOCKED_TOOLS): save_plan, update_task_status,
  phase_complete, lean_turbo_run_phase, lean_turbo_acquire_locks. If a call
  returns SPEC_DRIFT_BLOCK, do NOT retry; surface the drift to the user and
  WAIT for them to run /swarm clarify or /swarm acknowledge-spec-drift.
