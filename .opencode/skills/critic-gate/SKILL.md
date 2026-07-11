---
name: critic-gate
audience: swarm-plugin
description: >
  Full execution protocol for MODE: CRITIC-GATE -- plan critic review, revision loops, and hard stop before execution.
---

# Critic Gate Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: CRITIC-GATE
Delegate plan to the active swarm's critic agent for review BEFORE any implementation begins.
- Send the full plan.md content and codebase context summary
- Explicitly reference "plan.md" or "critic-gate" in the dispatch prompt text. This lets the mechanical approval-recording gate reliably detect the review and record the critic's APPROVED verdict, which the EXECUTE-phase coder gate then requires.
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
Caveat: this assumption breaks if the plan lacks a `plan_critic_gate`-tagged approval snapshot (e.g. a plan approved before this mechanical gate existed, or one where the recording heuristic didn't fire) — in that case the first coder dispatch will fail with `PLAN_CRITIC_GATE_VIOLATION`. If that happens, do not assume CRITIC-GATE is satisfied; re-run it and get a fresh APPROVED verdict.

6j. SPEC-GATE (Execute BEFORE any save_plan call):
- An effective spec exists iff `/swarm sdd status` reports a resolved spec (it reflects `readEffectiveSpecSync`, which returns null — NO effective spec — for no sources, multiple competing sources (openspec+specify), multi-feature Spec-Kit without a selected feature, or any unresolvable state). `save_plan` rejects (SPEC_REQUIRED) when `/swarm sdd status` reports no resolved spec. The gate is overridable via `SWARM_SKIP_SPEC_GATE=1`.
- Before calling save_plan, verify an effective spec exists (via `/swarm sdd status` or `lint_spec`).
- If no effective spec exists: do NOT call save_plan. Generate one first — native via `/swarm specify`, or via the agent-invocable `/swarm sdd project` (from SDD sources, after consent).
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

6l. OBLIGATION TRACEABILITY CHECK (FR-003):
- Before the critic's substantive rubric, the critic MUST cross-reference every
  MUST/SHALL SC-### obligation in the EFFECTIVE spec against the plan tasks.
  An effective spec exists iff `/swarm sdd status` reports a resolved spec (it
  reflects `readEffectiveSpecSync`, which returns null — NO effective spec — for
  no sources, multiple competing sources (openspec+specify), multi-feature
  Spec-Kit without a selected feature, or any unresolvable state). Obligations
  are traced only against the resolved effective spec; in a null/unresolved
  state there is nothing to trace (this check is not applicable).
- If ANY MUST/SHALL SC-### has zero corresponding plan tasks, the critic MUST
  return VERDICT: REJECTED enumerating each unmapped obligation.
- The critic MUST evaluate coverage against the FULL plan — each task's
  description AND acceptance criteria. An SC-### is "mapped" if referenced
  in ANY task's description OR acceptance field. Read plan.json (the structured
  plan object) rather than relying solely on plan.md, which omits acceptance
  criteria.
- This is a structural-completeness failure, not a style concern.
- The detection logic mirrors the existing ANALYZE-mode SC-### coverage check
  (see src/agents/critic.ts ANALYZE mode, step 4).
