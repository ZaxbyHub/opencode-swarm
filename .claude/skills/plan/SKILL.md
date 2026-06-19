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

### GENERAL COUNCIL ADVISORY OPTION (pre-save_plan)

Before drafting or saving the plan, the architect MUST offer General Council advisory input when `council.general.enabled` is true in the resolved opencode-swarm config and a search API key is configured.

- Ask the user: "Use General Council advisory input before I write the plan? The 3-agent council (generalist, skeptic, domain expert) will gather current external context and provide perspectives that I will fold into the plan before critic review. (default: no)"
- If the user declines, proceed to the clarification funnel and planning normally.
- If the user accepts:
  1. Run the General Council Research Phase: formulate 1-3 targeted `web_search` queries grounded in the work being planned.
  2. Dispatch `the active swarm's council_generalist agent`, `the active swarm's council_skeptic agent`, and `the active swarm's council_domain_expert agent` in PARALLEL with the RESEARCH CONTEXT.
  3. Collect responses and call `convene_general_council` with mode `general`.
  4. Record the council consensus, disagreements, cited sources, and any plan-impacting assumptions in `.swarm/context.md` under `## Decisions`.
  5. Use that recorded council input as planning context before calling `save_plan`.
- If General Council is unavailable and the user explicitly requested council input, surface the config/key requirement and stop before `save_plan` rather than writing an ungrounded plan.

General Council is advisory and distinct from `council_mode`, `phase_council`, and `final_council`. It is not a QA gate. Its purpose here is to make current external context available before the architect writes any plan and before any critic pre-plan review.

### CLARIFICATION FUNNEL (pre-save_plan)

Before calling `save_plan` — whether creating a new plan or finalizing an external plan ingestion — the architect MUST run this four-stage clarification funnel. The goal is to limit unnecessary user interruption, not planning completeness.

#### Stage 1: Inventory All Material Uncertainties

Identify ALL uncertainties that could affect the plan. There is NO hard cap on the internal inventory. Cover at minimum:

- Scope boundaries: what is in or out
- Data loss or destructive behavior
- Security/privacy risk tolerance
- Backward compatibility or migration policy
- Cost/performance tradeoffs
- User-visible behavior and UX choices
- Release/rollout strategy
- QA policy: gate selection and enforcement strictness
- Architecture choices among materially different paths
- Dependency or platform assumptions
- Operational complexity

#### Stage 2: Classify Each Uncertainty

Classify each item as exactly one of:

- `self_resolved`: answered from the user request, spec, plan, codebase reality check, `.swarm/context.md`, repo conventions, or an informed default. **If the default is not directly supported by user request, spec, or recorded context, classify as `user_decision` rather than `self_resolved`.**
- `critic_resolved`: sent to Critic Sounding Board and resolved by the critic.
- `research_needed`: needs SME/explorer/domain lookup before user escalation.
- `user_decision`: only the user can decide because it affects product scope, risk tolerance, policy, budget, UX, rollout, or destructive behavior.
- `deferred_nonblocking`: useful follow-up detail that does not block a correct initial plan and can be explicitly recorded as an assumption or follow-up.

#### Stage 3: Consult Critic Sounding Board Before User Escalation

Before asking the user any planning clarification question, the architect MUST consult `critic_sounding_board` with the candidate question set and context.

For each item classified as `research_needed` or `user_decision` in Stage 2, send it to the critic. The critic responds with a verdict from `SoundingBoardVerdict` (see `src/agents/critic.ts`). The mapping between critic verdicts and funnel actions is:

| Critic Verdict (SoundingBoardVerdict) | Funnel Action | Meaning |
|---|---|---|
| `UNNECESSARY` | DROP | Item is unnecessary or answerable from existing context |
| `RESOLVE` | RESOLVE | Critic supplies the answer or recommended default |
| `REPHRASE` | REPHRASE | Question is valid but should be clearer, narrower, or grouped |
| `APPROVED` | ASK_USER | User decision is genuinely required |

**Hard constraint:** Items in the Always-Surface Categories list (below) MUST NOT receive `UNNECESSARY`/`DROP` from the critic — only `REPHRASE` or `APPROVED`/`ASK_USER` are allowed. If the critic attempts to `UNNECESSARY`/`DROP` an always-surface item, override to `APPROVED`/`ASK_USER`.

**Overconfidence guard:** If the critic attempts to self-resolve an item by supplying an answer (verdict `RESOLVE`) but the underlying default is not directly supported by user request, spec, or recorded context, the architect MUST classify the item as `user_decision` rather than `self_resolved`. Unsupported defaults must not be silently accepted.

Update classifications based on critic response:

- `UNNECESSARY`/`DROP` → reclassify as `self_resolved` and record the reason.
- `RESOLVE` → reclassify as `critic_resolved` and record the answer as an assumption.
- `REPHRASE` → update the question wording and keep as candidate.
- `APPROVED`/`ASK_USER` → confirm as `user_decision`.

The architect MUST update the plan's assumptions with all resolved items before proceeding to Stage 4.

Exception: QA gate selection questions are already mandatory user decisions (enforced by the save_plan tool itself) and do NOT need to go through the funnel. QA gate selection is always a direct user dialogue.

#### Stage 4: Surface User Decision Packet

If any items remain classified as `user_decision` after Stage 3, present them as a structured decision packet — NOT as an arbitrary subset or a single question.

The packet MUST include for each decision:

- Category grouping (scope, security, compatibility, performance, UX, rollout, QA policy)
- Why the decision matters
- Recommended default when safe
- Options being weighed
- Impact of accepting the default
- Blocking vs optional marker

The architect MAY ask questions one at a time in interactive mode, but MUST preserve and report the full unresolved list. The architect MUST NOT drop unresolved decisions because of a session question cap.

#### Always-Surface Categories

The critic may improve wording or confirm prior context, but these categories MUST be surfaced to the user unless already explicitly answered by the user or by recorded context:

- Scope boundaries: what is in or out
- Data loss or destructive behavior
- Security/privacy risk tolerance
- Backward compatibility or migration policy
- Breaking changes to existing APIs, contracts, or interfaces
- New dependency additions or version changes
- Deprecation decisions for existing features or APIs
- Cross-platform impact (Windows/macOS/Linux differences)
- Cost/performance tradeoffs
- User-visible behavior and UX choices
- Release/rollout strategy
- Optional QA gates or stricter enforcement modes
- Any choice that changes whether the work is advisory vs hard-blocking

#### Assumptions Recording

All items resolved in Stages 2-3 (self_resolved, critic_resolved, deferred_nonblocking) MUST be recorded as explicit assumptions in `.swarm/context.md` under `## Decisions` before calling `save_plan`. Silently dropping resolved uncertainties is a protocol violation — every uncertainty that entered the funnel must have a recorded outcome.

The plan generated by `save_plan` MUST include explicit assumptions and remaining unresolved decisions in the task descriptions or acceptance criteria — not silently omit them.

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
- If no pending section exists, ask the user inline now. Present the eleven gates with their defaults (DEFAULT_QA_GATES), parallel coder count, and commit frequency as a single user-facing section. Offer the user a one-shot choice: accept defaults, or customize. The eleven gates are:
  - reviewer (default: ON) - code review of coder output
  - test_engineer (default: ON) - test verification of coder output
  - sme_enabled (default: ON) - SME consultation during planning/clarification
  - critic_pre_plan (default: ON) - critic review before plan finalization
  - sast_enabled (default: ON) - static security scanning
  - council_mode (default: OFF) - replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer). Requires council.enabled: true in config.
  - hallucination_guard (default: OFF) - mandatory per-phase API/signature/claim/citation verification at PHASE-WRAP
  - mutation_test (default: OFF) - mutation testing on source files touched this phase at PHASE-WRAP
  - phase_council (default: OFF) - full 5-member council reviews all work in a phase holistically at phase_complete time. Requires council.enabled: true in config.
  - drift_check (default: ON) - mandatory per-phase drift verification at PHASE-WRAP
  - final_council (default: OFF) - when enabled, after all phases complete the architect dispatches the full 5-member council (critic, reviewer, sme, test_engineer, explorer) -- NOT the General Council -- at project scope, collects `CouncilMemberVerdict` objects, and calls `write_final_council_evidence`. This does not require `council.general.enabled`.
  Additionally, present these two sub-items as part of the same exchange:
  - Parallel coders (default: 1, range: 1-4) - how many coders should run in parallel. Parallel coders each run in an isolated git worktree (separate working dir + branch) and merge back automatically, so they never overwrite each other's files - safe and faster, but only for tasks whose file scopes do NOT overlap. Inspect the plan and recommend a count equal to the number of dependency-ready, file-disjoint task groups (clamped 1-4); recommend 1 (serial) when scopes overlap or are unknown. State your recommendation and reasoning when you ask.
  - Commit frequency (default: phase-level only) - optional per-task checkpoint commit after each task completion.
  The user answers all three (gates, parallel coders, commit frequency) in one exchange. Wait for the user's response.
  If the user says parallel coders > 1, write a `## Pending Parallelization Config` section to `.swarm/context.md` alongside the gate selection:
  ```
  ## Pending Parallelization Config
  - parallelization_enabled: true
  - max_concurrent_tasks: <user's number>
  - council_parallel: false
  - locked: true
  - recorded_at: <ISO timestamp>
  ```
  If the user accepts the default (1), skip writing this section entirely; serial execution is the default and needs no config.
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

### Transition to CRITIC-GATE

After the QA gate selection has been persisted via `set_qa_gates` and the TRACEABILITY CHECK is complete:

1. If `critic_pre_plan` is enabled (default: ON): the plan MUST be reviewed by the critic before any implementation begins.
2. Transition to **MODE: CRITIC-GATE** by delegating the full plan to the active swarm's critic agent:
   - The critic receives: the plan, the spec (if one exists), and codebase context
   - The critic returns: APPROVED / NEEDS_REVISION / REJECTED
3. Wait for the critic's verdict before proceeding to MODE: EXECUTE.
4. If the critic approves: proceed to MODE: EXECUTE for implementation.
5. If the critic requests revision (NEEDS_REVISION): revise the plan and re-submit to the critic (max 2 cycles).
6. If the critic rejects after 2 cycles: escalate to the user with a full explanation.
