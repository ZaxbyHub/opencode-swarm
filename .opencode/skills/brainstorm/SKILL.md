---
name: brainstorm
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
- Delegate to `{{AGENT_PREFIX}}explorer` to map the relevant portion of the codebase. Scope the explorer to the area most likely affected by the topic.
- In parallel, read any existing `.swarm/spec.md`, `.swarm/plan.md`, and `.swarm/knowledge.jsonl` entries that are relevant.
- Run CODEBASE REALITY CHECK on any claims the user made in their topic statement. Surface discrepancies before moving forward.
- Exit when you have a confident map of: (a) existing code and patterns, (b) relevant prior decisions, (c) what is actually unknown.

**Phase 2: DIALOGUE (architect ↔ user).**
- Ask EXACTLY ONE focused question per message. Wait for the user's answer before asking the next.
- Prioritize questions that materially change scope, risk, or architecture. Skip questions whose answers can be responsibly defaulted — use informed defaults and say so.
- Hard cap: no more than SIX questions total in this phase. Stop sooner if uncertainty has collapsed.
- Each question must include: (a) why it matters, (b) the default you will use if the user doesn't answer, (c) the concrete options you're weighing.
- Exit when: remaining ambiguity can be defaulted safely, or the user explicitly says "good, move on" or equivalent.

**Phase 3: APPROACHES (architect, optionally with SME).**
- Produce 2-4 distinct candidate approaches. Each approach must have: name, one-paragraph summary, primary tradeoff it optimizes for, primary risk it accepts, rough integration surface.
- For high-risk domains (auth, payments, data mutation, public API, schema, concurrency, security-sensitive parsing), delegate to `{{AGENT_PREFIX}}sme` for domain research first.
- Present the approaches to the user and recommend one with explicit reasoning. The user can pick, modify, or reject.
- Exit when the user has chosen (or agreed to your recommended) approach.

**Phase 4: DESIGN SECTIONS (architect).**
- Draft the structural design of the chosen approach. Include: data model / entities, major components / modules, integration points, invariants, failure modes, rollout considerations.
- Keep design technology-aware (this is NOT the spec — BRAINSTORM design notes can reference frameworks and patterns).
- Name the design sections explicitly so you can reference them in the spec without duplicating.
- Exit with a design outline the user can skim in under two minutes.

**Phase 5: SPEC WRITE + SELF-REVIEW (architect + reviewer).**
- Generate `.swarm/spec.md` following the same SPEC CONTENT RULES that MODE: SPECIFY uses: WHAT/WHY only, no tech stack, no implementation details, FR-### / SC-### numbering, Given/When/Then scenarios, `[NEEDS CLARIFICATION]` markers (max 3).
- Cross-reference design sections by name where relevant context helps (but keep HOW out of the spec).
- Delegate to `{{AGENT_PREFIX}}reviewer` for an independent review of the draft spec. Reviewer must flag: requirements that encode HOW, untestable requirements, missing edge cases, silent assumptions.
- Apply reviewer feedback. If reviewer rejects, iterate once and re-review. After two rounds, surface remaining disagreements to the user.
- Write the final spec to `.swarm/spec.md`.
- Exit when reviewer signs off (or user explicitly accepts remaining disagreements).

**Phase 6: QA GATE SELECTION (architect, dialogue only).**
Now ask the user which QA gates to enable for this plan -- do not select on their behalf.

Present the eleven gates with their defaults (DEFAULT_QA_GATES) as a single user-facing question. Offer the user a one-shot choice: accept defaults, or customize. The eleven gates are:
- reviewer (default: ON) -- code review of coder output
- test_engineer (default: ON) -- test verification of coder output
- sme_enabled (default: ON) -- SME consultation during planning/clarification
- critic_pre_plan (default: ON) -- critic review before plan finalization
- sast_enabled (default: ON) -- static security scanning
- council_mode (default: OFF) -- multi-member council gate (recommended for high-impact architecture, public APIs, schema/data mutation, security-sensitive code)
- hallucination_guard (default: OFF) -- when enabled, mandatory per-phase API/signature/claim/citation verification via critic_hallucination_verifier at PHASE-WRAP; phase_complete will REJECT phase completion unless .swarm/evidence/{phase}/hallucination-guard.json exists with an APPROVED verdict (recommended for claim-heavy or research-heavy work)
- mutation_test (default: OFF) -- when enabled, runs mutation testing on source files touched this phase via generate_mutants + mutation_test + write_mutation_evidence at PHASE-WRAP; FAIL verdict blocks phase_complete; WARN is non-blocking (recommended for projects with coverage gaps or safety-critical code)
- council_general_review (default: OFF) -- when enabled, MODE: SPECIFY runs convene_general_council on the draft spec before the critic-gate; the architect runs a curated web_search pass, dispatches council_generalist / council_skeptic / council_domain_expert in parallel with a shared RESEARCH CONTEXT block, deliberates on disagreements, and synthesizes the result directly into the spec (recommended for novel architecture, unclear best practices, or high-risk design decisions). Requires council.general.enabled: true and a configured search API key.
- drift_check (default: ON) -- when enabled, mandatory per-phase drift verification via critic_drift_verifier at PHASE-WRAP; compares implemented changes against spec.md intent; hard-blocks phase_complete when spec.md exists and drift evidence is missing or REJECTED; advisory-only when no spec.md exists (recommended for all projects with a specification)
- final_council (default: OFF) - when enabled, after all phases complete the architect dispatches the same five phase-council members (`critic`, `reviewer`, `sme`, `test_engineer`, `explorer`) at project scope, collects `CouncilMemberVerdict` objects, and calls `write_final_council_evidence`. This is not General Council mode and does not require `council.general.enabled`.

One question, one message, defaults pre-stated. Wait for the user's answer.

If the user answered the gate question, immediately follow up with ONE more question: "How many coders should run in parallel? (default: 1, range: 1-4)" -- if the user says a number > 1, also write a `## Pending Parallelization Config` section to `.swarm/context.md` alongside the gate selection:
```
## Pending Parallelization Config
- parallelization_enabled: true
- max_concurrent_tasks: <user's number>
- council_parallel: false
- locked: true
- recorded_at: <ISO timestamp>
```
If the user accepts the default (1), skip writing this section entirely -- serial execution is the default and needs no config.

After asking the parallelization question (regardless of whether the user chose serial or parallel), immediately follow up with ONE more question: "Commit frequency for completed tasks? (default: phase-level only; optional per-task checkpoint commit after each task completion)".

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
  ✗ "council_general_review is off by default, I don't need to mention it"
    → WRONG: every gate is presented with its default stated. The user opts in or accepts the default explicitly.

MANDATORY PAUSE: Do NOT write the spec summary (step 7). Do NOT suggest next steps.
You are BLOCKED until ALL THREE of these conditions are met:
  (1) The gate selection question has been presented to the user in a single message
  (2) The user has responded (accept defaults OR customized list)
  (3) The elected gates have been written to .swarm/context.md under "## Pending QA Gate Selection"
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
- council_general_review: <true|false>
- drift_check: <true|false>
- final_council: <true|false>
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
- One question per message in DIALOGUE — never batch.
- Always offer an informed default for every question.
- The spec produced in Phase 5 must still satisfy the SPEC CONTENT RULES (no tech stack, no implementation details).
- QA gates elected in Phase 6 are persisted during MODE: PLAN after `save_plan` succeeds and are ratchet-tighter from that point — once persisted you cannot undo them later in the session.
