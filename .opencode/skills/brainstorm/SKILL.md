---
name: brainstorm
audience: swarm-plugin
description: >
  Full execution protocol for MODE: BRAINSTORM -- structured discovery dialogue, approach selection, spec drafting, QA gate selection, and transition handling.
---

# Brainstorm Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: BRAINSTORM
Activates when: user invokes `/swarm brainstorm`; OR uses phrases like "brainstorm", "let's think through", "think this through with me", "workshop this idea"; OR the problem is fuzzy/exploratory and the user has not yet written (or does not want to directly dictate) a spec.

Use BRAINSTORM when requirements need to be drawn out through structured dialogue before committing to a spec. Use SPECIFY when the user has already articulated clear requirements.

MODE: BRAINSTORM runs seven phases in strict order. Do not skip phases. Do not collapse phases. Each phase has a clear entry signal and a clear exit signal.

**Phase 1: CONTEXT SCAN (architect + explorer, parallel).**
- Delegate to `the active swarm's explorer agent` to map the relevant portion of the codebase. Scope the explorer to the area most likely affected by the topic.
- In parallel, read any existing `.swarm/spec.md`, `.swarm/plan.md`, and `.swarm/knowledge.jsonl` entries that are relevant.
- Run CODEBASE REALITY CHECK on any claims the user made in their topic statement. Surface discrepancies before moving forward.
- Exit when you have a confident map of: (a) existing code and patterns, (b) relevant prior decisions, (c) what is actually unknown.

**Phase 1b: GENERAL COUNCIL ADVISORY (optional, architect).**
If `council.general.enabled` is true in the resolved opencode-swarm config AND a search API key is configured:
- Ask the user: "Enable General Council advisory input? The 3-agent council (generalist, skeptic, domain expert) will research the problem domain and provide diverse perspectives to inform the specification and plan. (default: no)"
- If the user declines or config is not enabled, skip to Phase 2.
- If the user accepts:
  1. Run the Research Phase: formulate 1-3 targeted `web_search` queries grounded in the topic.
  2. Dispatch `the active swarm's council_generalist agent`, `the active swarm's council_skeptic agent`, and `the active swarm's council_domain_expert agent` in PARALLEL with the RESEARCH CONTEXT.
  3. Collect responses, call `convene_general_council` with mode `general`.
  4. Carry the council's consensus and disagreements forward as context for subsequent phases.
- Exit with council input noted (or skipped).

**Phase 2: DIALOGUE (architect ↔ user).**
- Ask EXACTLY ONE focused question per message. Wait for the user's answer before asking the next.
- Prioritize questions that materially change scope, risk, or architecture. Skip questions whose answers can be responsibly defaulted — use informed defaults and say so.
- Hard cap: no more than SIX questions total in this phase. Stop sooner if uncertainty has collapsed.
- Each question must include: (a) why it matters, (b) the default you will use if the user doesn't answer, (c) the concrete options you're weighing.
- Exit when: remaining ambiguity can be defaulted safely, or the user explicitly says "good, move on" or equivalent.

**Phase 3: APPROACHES (architect, optionally with SME).**
- Produce 2-4 distinct candidate approaches. Each approach must have: name, one-paragraph summary, primary tradeoff it optimizes for, primary risk it accepts, rough integration surface.
- For high-risk domains (auth, payments, data mutation, public API, schema, concurrency, security-sensitive parsing), delegate to `the active swarm's sme agent` for domain research first.
- Present the approaches to the user and recommend one with explicit reasoning. The user can pick, modify, or reject.
- Exit when the user has chosen (or agreed to your recommended) approach.

**Phase 4: DESIGN SECTIONS (architect).**
- Draft the structural design of the chosen approach. Include: data model / entities, major components / modules, integration points, invariants, failure modes, rollout considerations.
- Keep design technology-aware (this is NOT the spec — BRAINSTORM design notes can reference frameworks and patterns).
- Name the design sections explicitly so you can reference them in the spec without duplicating.
- Exit with a design outline the user can skim in under two minutes.

**Phase 5: SPEC WRITE + SELF-REVIEW (architect + reviewer).**
    - Generate `.swarm/spec.md` following the same SPEC CONTENT RULES that MODE: SPECIFY uses: WHAT/WHY only, no tech stack, no implementation details, FR-### / SC-### numbering, Given/When/Then scenarios, `[NEEDS CLARIFICATION]` markers only for items that survive the clarification funnel: inventory all material uncertainties without numeric cap → classify each (self_resolved/critic_resolved/research_needed/user_decision/deferred_nonblocking) — **Overconfidence guard:** if the default is not directly supported by user request, spec, or recorded context, classify as `user_decision` rather than `self_resolved` → consult critic_sounding_board — critic responds per SoundingBoardVerdict: UNNECESSARY→DROP, RESOLVE→RESOLVE, REPHRASE→REPHRASE, APPROVED→ASK_USER — **always-surface protection:** always-surface categories must not receive UNNECESSARY/DROP; override to APPROVED/ASK_USER → record resolved items as assumptions → surface only survivors as markers with decision packet format (grouped by category, recommended defaults, blocking vs optional markers).
    - **Important:** If research is ongoing, apply a fixed 5-minute protocol budget to `research_needed`. If research does not complete before the budget expires, automatically reclassify the item to `user_decision` with a note that research was incomplete, then surface it to the user. This prevents the clarification funnel from stalling while waiting for external research.
- Cross-reference design sections by name where relevant context helps (but keep HOW out of the spec).
- Delegate to `the active swarm's reviewer agent` for an independent review of the draft spec. Reviewer must flag: requirements that encode HOW, untestable requirements, missing edge cases, silent assumptions.
- Apply reviewer feedback. If reviewer rejects, iterate once and re-review. After two rounds, surface remaining disagreements to the user.
- Before writing `.swarm/spec.md`, apply the FR-002 non-shadowing check: if a non-native spec already exists, do not shadow it (see MODE: SPECIFY step 1b).
- Write the final spec to `.swarm/spec.md`.
- Exit when reviewer signs off (or user explicitly accepts remaining disagreements).

**Phase 6: QA GATE SELECTION, PARALLEL CODERS, AND COMMIT FREQUENCY (architect, dialogue only).**
Auto-loop exception: when BRAINSTORM is running inside MODE: LOOP with
`autonomy=auto`, do not ask this preference question. Write the balanced-speed
default `## Pending QA Gate Selection` instead (reviewer, test_engineer,
sme_enabled, critic_pre_plan, sast_enabled, drift_check ON; council_mode,
hallucination_guard, mutation_test, phase_council, final_council OFF). Do not
write `## Pending Parallelization Config` here because task scopes are not known
until PLAN; MODE: PLAN will choose safe parallelism automatically. Keep commit
frequency at phase-level only.
Now ask the user which QA gates to enable for this plan, how many parallel coders to use, the commit frequency, and auto_proceed -- do not select on their behalf. Present all four items together as one unified exchange.

Present the eleven gates with their defaults (DEFAULT_QA_GATES), parallel coder count, commit frequency, and auto_proceed as a single user-facing section. Offer the user a one-shot choice: accept defaults, or customize. The eleven gates are:
- reviewer (default: ON) -- code review of coder output
- test_engineer (default: ON) -- test verification of coder output
- sme_enabled (default: ON) -- SME consultation during planning/clarification
- critic_pre_plan (default: ON) -- critic review before plan finalization
- sast_enabled (default: ON) -- static security scanning
- council_mode (default: OFF) -- replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer). Requires council.enabled: true in config. (recommended for high-impact architecture, public APIs, schema/data mutation, security-sensitive code)
- hallucination_guard (default: OFF) -- when enabled, mandatory per-phase API/signature/claim/citation verification via critic_hallucination_verifier at PHASE-WRAP; phase_complete will REJECT phase completion unless .swarm/evidence/{phase}/hallucination-guard.json exists with an APPROVED verdict (recommended for claim-heavy or research-heavy work)
- mutation_test (default: OFF) -- when enabled, runs mutation testing on source files touched this phase via generate_mutants + mutation_test + write_mutation_evidence at PHASE-WRAP; FAIL verdict blocks phase_complete; WARN is non-blocking (recommended for projects with coverage gaps or safety-critical code)
- phase_council (default: OFF) -- full 5-member council reviews all work in a phase holistically at phase_complete time. Requires council.enabled: true in config. (recommended for multi-task phases with cross-cutting concerns or high-risk integration)
- drift_check (default: ON) -- when enabled, mandatory per-phase drift verification via critic_drift_verifier at PHASE-WRAP; compares implemented changes against spec.md intent; hard-blocks phase_complete when spec.md exists and drift evidence is missing or REJECTED; advisory-only when no spec.md exists (recommended for all projects with a specification)
- final_council (default: OFF) -- when enabled, after all phases complete the architect dispatches the full 5-member council (critic, reviewer, sme, test_engineer, explorer) -- NOT the General Council -- at project scope, collects `CouncilMemberVerdict` objects, and calls `write_final_council_evidence`. This does not require `council.general.enabled`.

Additionally, present these three sub-items as part of the same exchange:
- Parallel coders (default: 1, range: 1-6) -- how many coders should run in parallel. Parallel coders each run in an isolated git worktree (separate working dir + branch) and merge back automatically, so they never overwrite each other's files -- safe and faster, but only for tasks whose file scopes do NOT overlap. The per-task file scopes that determine a safe parallel count are not known until the plan is finalized, so default to 1 (serial) here; the precise recommendation is made at plan time once the tasks and their scopes exist.
  > COMMON MISCONCEPTION: worktree isolation is baseline for standard parallel coders, governed by the parallel execution profile plus top-level `worktree.policy`. It is not provided by Lean Turbo or Epic. Do not recommend Lean Turbo or Epic to obtain worktree isolation; recommend them only for what they add beyond baseline (Lean Turbo: lane planning, file locks, phase reviewer, integrated diff; Epic: co-change awareness and auto-decide). Worktrees also do not make overlapping scopes safe: dependency readiness, file-disjoint scopes, and merge-back ownership are still required.
- Commit frequency (default: phase-level only) -- optional per-task checkpoint commit after each task completion.
- auto_proceed (boolean, default: false) -- when true, auto-advance to the next phase without asking "Ready for Phase N+1?"; runtime toggle via /swarm auto-proceed on|off.

The user answers all four items (gates, parallel coders, commit frequency, auto_proceed) in one exchange. Wait for the user's response.

If the user says parallel coders > 1, write a `## Pending Parallelization Config` section to `.swarm/context.md` alongside the gate selection:
```
## Pending Parallelization Config
- parallelization_enabled: true
- max_concurrent_tasks: <user's number>
- council_parallel: false
- locked: true
- recorded_at: <ISO timestamp>
```
If the user accepts the default (1), skip writing this section entirely -- serial execution is the default and needs no config.

If the user chooses per-task commits, write this section to `.swarm/context.md`:
```
## Task Completion Commit Policy
- commit_after_each_completed_task: true
- recorded_at: <ISO timestamp>
```
If the user keeps the default phase-level behavior, do not write this section.

<!-- BEHAVIORAL_GUIDANCE_START -->
GATE SELECTION IS MANDATORY — these thoughts are WRONG and must be ignored:
  ✗ "I'll use the defaults — they're probably fine"
    → WRONG: defaults are not the user's decision. The user must be asked every time.
  ✗ "The user didn't mention gates, so defaults are fine"
    → WRONG: silence is not consent. The gate dialogue is not optional.
  ✗ "I'll handle it in MODE: PLAN after the spec is done"
    → WRONG: ## Pending QA Gate Selection must exist in context.md BEFORE save_plan is called.
      save_plan will reject with QA_GATE_SELECTION_REQUIRED if this section is absent.
  ✗ "This feature is simple — gates are obvious"
    → WRONG: complexity does not exempt this step. Gate selection is mandatory for ALL plans.
  ✗ "I already know which gates are right for this project"
    → WRONG: the architect does not configure gates. The user configures gates. Always ask.

MANDATORY PAUSE: Do NOT write the spec summary (Phase 7 transition). Do NOT suggest next steps.
Exception: MODE: LOOP with `autonomy=auto` uses the balanced-speed defaults
above and does not pause for this preference exchange.
You are BLOCKED until ALL THREE of these conditions are met:
  (1) The unified gate/coders/commit/auto_proceed selection section has been presented to the user in a single message
  (2) The user has responded (accept defaults OR customized list for all four items)
  (3) The elected gates, parallel coder config, commit policy, and auto_proceed selection have been written to .swarm/context.md under "## Pending QA Gate Selection" (and related sections as applicable)
<!-- BEHAVIORAL_GUIDANCE_END -->

Do NOT call `set_qa_gates` yet — `plan.json` does not exist at this point. Once the user answers, write the elected gates to `.swarm/context.md` under a new section:
```
## Pending QA Gate Selection
- reviewer: <true|false>
- test_engineer: <true|false>
- sme_enabled: <true|false>
- critic_pre_plan: <true|false>
- sast_enabled: <true|false>
- council_mode: <true|false>
- hallucination_guard: <true|false>
- mutation_test: <true|false>
- phase_council: <true|false>
- drift_check: <true|false>
- final_council: <true|false>
- auto_proceed: <true|false>
- recorded_at: <ISO timestamp>
```
MODE: PLAN applies these after `save_plan` succeeds via `set_qa_gates`.
- Exit with the elected gates recorded in `.swarm/context.md` (NOT yet persisted to plan.json).

**Phase 7: TRANSITION.**
- Summarize: (a) chosen approach, (b) design sections produced, (c) spec written, (d) QA gates selected, (e) remaining `[NEEDS CLARIFICATION]` markers.
- Offer the user two next steps: `PLAN` (go to MODE: PLAN and write plan.md) or `CLARIFY-SPEC` (resolve remaining markers first).
- Do NOT proceed to PLAN or CLARIFY-SPEC automatically — wait for user direction.

BRAINSTORM RULES:
- No skipping phases. Each phase's exit condition must be met before moving on.
- One question per message in DIALOGUE — never batch. Exception: the QA gate selection section (Phase 6) presents gates, parallel coders, and commit frequency together as one unified exchange.
- Always offer an informed default for every question.
- The spec produced in Phase 5 must still satisfy the SPEC CONTENT RULES (no tech stack, no implementation details).
- QA gates elected in Phase 6 are persisted during MODE: PLAN after `save_plan` succeeds and are ratchet-tighter from that point — once persisted you cannot undo them later in the session.
