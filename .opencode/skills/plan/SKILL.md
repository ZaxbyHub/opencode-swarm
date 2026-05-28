---
name: plan
description: >
  Full execution protocol for MODE: PLAN -- plan creation, external plan ingestion, QA gate persistence, task granularity, and traceability checks.
---

# Plan Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: PLAN

SPEC GATE (soft — check before planning):
- If `.swarm/spec.md` does NOT exist:
  - PLAN INGESTION DETECTION: Check if the user is providing an external plan (indicators: markdown content with Phase/Task structure, or phrases like "ingest this plan", "implement this plan", "prepare for implementation", "here is a plan", "here's the plan"):
    - If plan ingestion is detected AND no spec.md exists: offer this choice FIRST before any planning:
      1. "Generate spec from this plan first" → enter EXTERNAL PLAN IMPORT PATH in MODE: SPECIFY to reverse-engineer a spec.md from the provided plan, then return to planning
      2. "Skip spec and proceed with the provided plan" → proceed directly to plan ingestion and planning without creating a spec
    - This is a SOFT gate — option 2 always lets the user proceed without a spec
  - If no plan ingestion detected: Warn: "No spec found. A spec helps ensure the plan covers all requirements and gives the critic something to verify against. Would you like to create one first?"
    - Offer two options:
      1. "Create a spec first" → transition to MODE: SPECIFY
      2. "Skip and plan directly" → continue with the steps below unchanged
- If `.swarm/spec.md` EXISTS:
  - NOTE: Stale detection is intentionally heuristic (compare headings) — false positives are acceptable because this is a SOFT gate. When in doubt, ask the user.
  - Read the spec and compare its first heading (or feature description) against the current planning context (the user's request and any existing plan.md title/phase names)
  - STALE SPEC DETECTION: If the spec heading or feature description does NOT match the current work being planned (e.g., spec describes "user authentication" but user is asking to plan "payment integration"), treat the spec as potentially stale and offer three options:
    1. **Archive and create new spec** → attempt to rename .swarm/spec.md to .swarm/spec-archive/spec-{YYYY-MM-DD}.md (create the directory if needed); if archival succeeds: enter MODE: SPECIFY and skip the "spec already exists" prompt; if archival fails: inform user of the failure and offer: retry archival, or proceed with option 2, or proceed with option 3
    2. **Keep existing spec** → use spec.md as-is and proceed with planning below
    3. **Skip spec entirely** → proceed to planning below ignoring the existing spec
  - If the spec appears current (heading matches the work being planned) OR user chose option 2 above, proceed with spec:
    - Read it and use it as the primary input for planning
    - Cross-reference requirements (FR-###) when decomposing tasks
    - Ensure every FR-### maps to at least one task
    - If a task has no corresponding FR-###, flag it as a potential gold-plating risk
  - If user chose option 3 above, proceed without spec: skip all spec-based steps and proceed directly to planning

This is a SOFT gate. When the user chooses "Skip and plan directly", proceed to the steps below exactly as before — do NOT modify any planning behavior.

Run CODEBASE REALITY CHECK scoped to codebase elements referenced in spec.md or user constraints. Discrepancies must be reflected in the generated plan.

Use the `save_plan` tool to create the implementation plan. Required parameters:
- `title`: The real project name from the spec (NOT a placeholder like [Project])
- `swarm_id`: The swarm identifier (e.g. "mega", "local", "paid")
- `phases`: Array of phases, each with `id` (number), `name` (string), and `tasks` (array)
- Each task needs: `id` (e.g. "1.1"), `description` (real content from spec — bracket placeholders like [task] will be REJECTED)
- Optional task fields: `size` (small/medium/large), `depends` (array of task IDs), `acceptance` (string)

Example call:
save_plan({ title: "My Real Project", swarm_id: "mega", phases: [{ id: 1, name: "Setup", tasks: [{ id: "1.1", description: "Install dependencies and configure TypeScript", size: "small" }] }] })

**EXECUTION PROFILE (Optional — set during planning, lock before first task)**

The `execution_profile` field in `save_plan` controls plan-scoped concurrency. It is independent of the global plugin config and takes precedence when locked.

Fields:
- `parallelization_enabled` (boolean, default false): When true, tasks may run in parallel.
- `max_concurrent_tasks` (integer 1–64, default 1): Maximum simultaneous tasks when parallel is enabled.
- `council_parallel` (boolean, default false): When true, council review phases may parallelise.
- `locked` (boolean, default false): When true, the profile is immutable — future save_plan calls that include execution_profile will be REJECTED (fail-closed).

WHEN TO SET IT:
1. After the critic approves the plan, decide if this plan warrants parallel execution.
2. Call save_plan with execution_profile to record the decision.
3. Lock it (locked: true) in the same or a follow-up save_plan call before the first task dispatches.
4. Do NOT change a locked profile — if circumstances change, use reset_statuses: true to start fresh.

LOCK DISCIPLINE:
- A locked profile signals that concurrency constraints are authoritative for this plan.
- The delegation gate enforces the locked profile — it cannot be bypassed.
- If you do NOT set an execution_profile, serial (sequential) execution applies (safe default).
- If the plan has a locked profile with parallelization_enabled: false, Stage B parallel dispatch is blocked even if the global config enables it.

WRONG: Setting execution_profile after tasks have started (profile would not apply retroactively).
WRONG: Setting locked: true and then trying to change it — save_plan will reject the update.
WRONG: Assuming the global plugin config overrides a locked profile — it does not.

Example (set and lock in one call):
save_plan({
  title: "My Project",
  swarm_id: "mega",
  phases: [...],
  execution_profile: { parallelization_enabled: true, max_concurrent_tasks: 3, council_parallel: false, locked: true }
})

**POST-SAVE_PLAN: APPLY QA GATE SELECTION.**
After `save_plan` succeeds, read `.swarm/context.md`:
- If a `## Pending QA Gate Selection` section exists: parse the gate values, call `set_qa_gates` with those flags, confirm with the user ("QA gates applied: <list>"), then remove the section from context.md.
- If a `## Pending Parallelization Config` section also exists: parse the values and call `save_plan` again with `execution_profile` set to `{ parallelization_enabled: <parsed>, max_concurrent_tasks: <parsed>, council_parallel: false, locked: true }`. Then remove the section from context.md. If the plan already had `execution_profile.locked: true`, skip this step — the profile is already locked and immutable.
- If a `## Task Completion Commit Policy` section exists: preserve it in `.swarm/context.md` (do NOT remove). This section is execution-time guidance for optional per-task checkpoint commits after `update_task_status(status="completed")`.
- If no pending section exists, ask the user inline now. Present the eleven gates with their defaults (DEFAULT_QA_GATES) as a single user-facing question. Offer the user a one-shot choice: accept defaults, or customize. The eleven gates are:
  - reviewer (default: ON) - code review of coder output
  - test_engineer (default: ON) - test verification of coder output
  - sme_enabled (default: ON) - SME consultation during planning/clarification
  - critic_pre_plan (default: ON) - critic review before plan finalization
  - sast_enabled (default: ON) - static security scanning
  - council_mode (default: OFF) - multi-member council gate
  - hallucination_guard (default: OFF) - mandatory per-phase API/signature/claim/citation verification at PHASE-WRAP
  - mutation_test (default: OFF) - mutation testing on source files touched this phase at PHASE-WRAP
  - council_general_review (default: OFF) - General Council review during MODE: SPECIFY when council.general.enabled is true
  - drift_check (default: ON) - mandatory per-phase drift verification at PHASE-WRAP
  - final_council (default: OFF) - final project-scope council after all phases complete
  One question, one message, defaults pre-stated. Wait for the user's answer.
  If the user answered the gate question, immediately follow up with one more question: "How many coders should run in parallel? (default: 1, range: 1-4)" If the user says a number greater than 1, also write a `## Pending Parallelization Config` section to `.swarm/context.md` alongside the gate selection:
  ```
  ## Pending Parallelization Config
  - parallelization_enabled: true
  - max_concurrent_tasks: <user's number>
  - council_parallel: false
  - locked: true
  - recorded_at: <ISO timestamp>
  ```
  If the user accepts the default (1), skip writing this section entirely; serial execution is the default and needs no config.
  After asking the parallelization question, immediately follow up with one more question: "Commit frequency for completed tasks? (default: phase-level only; optional per-task checkpoint commit after each task completion)".
  If the user chooses per-task commits, write this section to `.swarm/context.md`:
  ```
  ## Task Completion Commit Policy
  - commit_after_each_completed_task: true
  - recorded_at: <ISO timestamp>
  ```
  If the user keeps the default phase-level behavior, do not write this section.
- If a `## Task Completion Commit Policy` section already exists in context.md, honor it as execution-time guidance (do NOT remove).
- If no `## Task Completion Commit Policy` section exists AND pending gate/parallelization sections were pre-written, ask the commit-frequency question now. Write the section to context.md if the user chooses per-task commits; skip if they keep the default phase-level behavior.
<!-- BEHAVIORAL_GUIDANCE_START -->
INLINE GATE SELECTION — no pending section found in context.md. You MUST ask now.
  ✗ "I'll call set_qa_gates with defaults and move on"
    → WRONG: set_qa_gates with assumed values is a gate violation. The user must answer first.
  ✗ "The user provided a plan — they know what gates they want"
    → WRONG: providing a plan is not the same as configuring gates. Always ask.

MANDATORY PAUSE: Present the gate question. Wait for the user's answer.
Do NOT call `set_qa_gates` until the user has responded.
<!-- BEHAVIORAL_GUIDANCE_END -->
Then call `set_qa_gates` with the user's chosen flags.
Either path must yield a persisted QA gate profile before the first task dispatches.

⚠️ If `save_plan` is unavailable, delegate plan writing to the active swarm's coder agent:
⚠️ Even in this fallback, you MUST call `declare_scope` for ".swarm/plan.md" BEFORE the coder delegation. Scope discipline applies to plan-writing delegations too. See Rule 1a.
TASK: Write the implementation plan to .swarm/plan.md
OUTPUT: .swarm/plan.md
INPUT: [provide the complete plan content below]
CONSTRAINT: Write EXACTLY the content provided. Do not modify, summarize, or interpret.

TASK GRANULARITY RULES:
- SMALL task: 1 file, 1 logical concern. Delegate as-is.
- MEDIUM task: 2-5 files within a single logical concern (e.g., implementation + test + type update). Delegate as-is.
- LARGE task: 6+ files OR multiple unrelated concerns. SPLIT into sequential single-file tasks before writing to plan. A LARGE task in the plan is a planning error — do not write oversized tasks to the plan.
- Litmus test: Can you describe this task in 3 bullet points? If not, it's too large. Split only when concerns are unrelated.
- Compound verbs are OK when they describe a single logical change: "add validation to handler and update its test" = 1 task. "implement auth and add logging and refactor config" = 3 tasks (unrelated concerns).
- Coder receives ONE task. You make ALL scope decisions in the plan. Coder makes zero scope decisions.

TEST TASK DEDUPLICATION:
The QA gate (Stage B, step 5l) runs test_engineer-verification on EVERY implementation task.
This means tests are written, run, and verified as part of the gate — NOT as separate plan tasks.

DO NOT create separate "write tests for X" or "add test coverage for X" tasks. They are redundant with the gate and waste execution budget.

Research confirms this: controlled experiments across 6 LLMs (arXiv:2602.07900) found that large shifts in test-writing volume yielded only 0–2.6% resolution change while consuming 20–49% more tokens. The gate already enforces test quality; duplicating it in plan tasks adds cost without value.

CREATE a dedicated test task ONLY when:
  - The work is PURE test infrastructure (new fixtures, test helpers, mock factories, CI config) with no implementation
  - Integration tests span multiple modules changed across different implementation tasks within the same phase
  - Coverage is explicitly below threshold and the user requests a dedicated coverage pass

If in doubt, do NOT create a test task. The gate handles it.
Note: this is prompt-level guidance for the architect's planning behavior, not a hard gate — the behavioral enforcement is that test_engineer already writes tests at the QA gate level.

PHASE COUNT GUIDANCE:
- Plans with 5+ tasks SHOULD be split into at least 2 phases.
- Plans with 10+ tasks MUST be split into at least 3 phases.
- Each phase should be a coherent unit of work that can be reviewed and learned from
  before proceeding to the next.
- Single-phase plans are acceptable ONLY for small projects (1-4 tasks).
- Rationale: Retrospectives at phase boundaries capture lessons that improve subsequent
  phases. A single-phase plan gets zero iterative learning benefit.

Also create .swarm/context.md with: decisions made, patterns identified, SME cache entries, and relevant file map.

TRACEABILITY CHECK (run after plan is written, when spec.md exists):
- Every FR-### in spec.md MUST map to at least one task → unmapped FRs = coverage gap, flag to user
- Every task MUST reference its source FR-### in the description or acceptance field → tasks with no FR = potential gold-plating, flag to critic
- Report: "TRACEABILITY: <N> FRs mapped, <M> unmapped FRs (gap), <K> tasks with no FR mapping (gold-plating risk)"
- If no spec.md: skip this check silently.
