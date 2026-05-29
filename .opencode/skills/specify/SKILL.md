---
name: specify
description: >
  Full execution protocol for MODE: SPECIFY -- spec creation, codebase reality checks, SME input, QA gate persistence, and optional council spec review.
---

# Specify Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: SPECIFY
Activates when: user asks to "specify", "define requirements", "write a spec", or "define a feature"; OR `/swarm specify` is invoked; OR no `.swarm/spec.md` exists and no `.swarm/plan.md` exists.

1. Check if `.swarm/spec.md` already exists.
   - If YES (and this is not a call from the stale spec archival path in MODE: PLAN): ask the user "A spec already exists. Do you want to overwrite it or refine it?"
     - Overwrite → ARCHIVE FIRST: read the existing spec, extract version (priority order): (1) from spec heading, look for patterns like "v{semver}" or "Version {semver}" in the first H1/H2; (2) from package.json version field in project root; create `.swarm/spec-archive/` directory if it does not exist; copy existing spec.md to `.swarm/spec-archive/spec-v{version}.md`; if version cannot be determined, use date-based fallback: `.swarm/spec-archive/spec-{YYYY-MM-DD}.md`; log the archive location to the user ("Archived existing spec to .swarm/spec-archive/spec-v{version}.md"); then proceed to generation (step 2)
     - Refine → delegate to MODE: CLARIFY-SPEC
   - If NO: proceed to generation (step 2)
   - If this is called from the stale spec archival path (MODE: PLAN option 1) — archival was already completed; skip this check and proceed directly to generation (step 2)
1b. Run CODEBASE REALITY CHECK for any codebase references mentioned by the user or implied by the feature. Skip if work is purely greenfield (no existing codebase to check). Report discrepancies before proceeding to explorer.
2. Delegate to `the active swarm's explorer agent` to scan the codebase for relevant context (existing patterns, related code, affected areas).
3. Delegate to `the active swarm's sme agent` for domain research on the feature area to surface known constraints, best practices, and integration concerns.
4. Generate `.swarm/spec.md` capturing:
   - First line must be: `# Specification: <feature-name>`
   - Feature description: WHAT users need and WHY — never HOW to implement
   - User scenarios with acceptance criteria (Given/When/Then format)
   - Functional requirements numbered FR-001, FR-002… using MUST/SHOULD language
   - Success criteria numbered SC-001, SC-002… — measurable and technology-agnostic
   - Key entities if data is involved (no schema or field definitions — entity names only)
   - Edge cases and known failure modes
    - `[NEEDS CLARIFICATION]` markers for items where uncertainty could change scope, security, or core behavior, BUT ONLY after running the clarification funnel: (1) inventory all material uncertainties without numeric cap, (2) classify each as self_resolved/critic_resolved/research_needed/user_decision/deferred_nonblocking — **overconfidence guard:** if the default is not directly supported by user request, spec, or recorded context, classify as `user_decision` rather than `self_resolved`, (3) consult critic_sounding_board with candidate items — critic responds per SoundingBoardVerdict: UNNECESSARY→DROP, RESOLVE→RESOLVE, REPHRASE→REPHRASE, APPROVED→ASK_USER — **always-surface protection:** always-surface categories must not receive UNNECESSARY/DROP; override to APPROVED/ASK_USER, (4) record all resolved items as explicit assumptions in the spec, (5) use markers only for items that survive the funnel (ASK_USER or unresolved after critic consultation). Decision packet format: grouped by category, recommended defaults, blocking vs optional markers, impact of accepting default. Prefer informed defaults over asking
5. Write the spec to `.swarm/spec.md`.
5b. **QA GATE SELECTION (dialogue only).**
Ask the user which QA gates to enable for this plan before suggesting the next step.

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
MODE: PLAN will read this section after `save_plan` succeeds and persist via `set_qa_gates`.

5c. **SPECIFY-COUNCIL-REVIEW (fires ONLY when council_general_review gate is true).**
Read the elected QA gates (parse the `## Pending QA Gate Selection` section from `.swarm/context.md` you just wrote, OR call `get_qa_gate_profile` if a profile already exists). If `council_general_review` is false or absent, skip directly to step 7.

If `council_general_review` is true:
1. Read `council.general` config. If `council.general.enabled` is not true OR no search API key is configured, surface to the user: "council_general_review gate is enabled but the General Council is not configured. Set council.general.enabled: true and configure a search API key in opencode-swarm.json, or unset council_general_review and re-run." Then stop.
2. Run the Research Phase: formulate 1–3 targeted `web_search` queries grounded in the spec's domain, then compile a RESEARCH CONTEXT block (same format as MODE: COUNCIL step 2). If web_search fails, proceed without a context block.
3. Dispatch `the active swarm's council_generalist agent`, `the active swarm's council_skeptic agent`, and `the active swarm's council_domain_expert agent` in PARALLEL — one message per agent, then STOP and wait. Pass: the spec text as the question, round number 1, the RESEARCH CONTEXT block, and the instruction "Cite from the RESEARCH CONTEXT for external evidence. Your memberId and role are hardcoded in your system prompt." Do NOT share other agents' perspectives at this stage.
4. Collect all three JSON responses.
5. Call `convene_general_council` with mode: 'spec_review', the spec as question, and the collected `round1Responses`. Omit `round2Responses` — spec review is a single-pass advisory, not a full deliberation.
6. Read `consensusPoints` — incorporate unambiguous consensus directly into the spec.
7. Read `disagreements` — for each: (a) accept one position with rationale, (b) mark as `[NEEDS CLARIFICATION]` in the spec, or (c) schedule an SME consultation.
8. Synthesize the final spec-review answer directly from the `synthesis` returned by `convene_general_council`. Apply the same inline output rules as MODE: COUNCIL step 7 (LEAD WITH CONSENSUS, ACKNOWLEDGE DISAGREEMENT HONESTLY, CITE THE STRONGEST SOURCES, BE CONCISE, HARD CONSTRAINTS — never invent claims, never add new web research, never favor a position on confidence alone).
9. Revise `.swarm/spec.md` to reflect the council input.

<!-- BEHAVIORAL_GUIDANCE_START -->
SPECIFY-COUNCIL-REVIEW RULES:
  ✗ "council_general_review is off by default, I'll skip this"
    → CORRECT only when the gate is explicitly false or absent. Do NOT assume false. Read the actual gate value before deciding to skip.
  ✗ "The spec is already good, no need to ask the council"
    → WRONG when gate is true: the user enabled this gate for a reason. Run it regardless.
  ✗ "I'll include round2Responses for spec_review — more is better"
    → WRONG: spec review is a single advisory pass. Omit `round2Responses` for spec_review mode.
  ✗ "I'll skip the Research Phase to save time"
    → WRONG: the council agents have no tools and depend on the architect-supplied RESEARCH CONTEXT for external evidence. Skipping the pre-search degrades every downstream agent's grounding.
<!-- BEHAVIORAL_GUIDANCE_END -->

7. Report a summary to the user (MUST count, SHALL count, scenario count, clarification markers, elected QA gates) and suggest the next step: `CLARIFY-SPEC` (if markers exist) or `PLAN`.

SPEC CONTENT RULES — the spec MUST NOT contain:
- Technology stack, framework choices, library names
- File paths, API endpoint designs, database schema, code structure
- Implementation details or "how to build" language
- Any reference to specific tools, languages, or platforms

Each functional requirement MUST be independently testable.
Focus on WHAT users need and WHY — never HOW to implement.
No technology stack, APIs, or code structure in the spec.
Each requirement must be independently testable.
Prefer informed defaults over asking the user — use `[NEEDS CLARIFICATION]` only when uncertainty could change scope, security, or core behavior.

EXTERNAL PLAN IMPORT PATH — when the user provides an existing implementation plan (markdown content, pasted text, or a reference to a file):
1. Run CODEBASE REALITY CHECK scoped to every file, function, API, and behavioral assumption in the provided plan. Report discrepancies to user before proceeding.
2. Read and parse the provided plan content.
3. Reverse-engineer `.swarm/spec.md` from the plan:
   - Derive FR-### functional requirements from task descriptions
   - Derive SC-### success criteria from acceptance criteria in tasks
   - Identify user scenarios from the plan's phase/feature groupings
   - Surface implicit assumptions as `[NEEDS CLARIFICATION]` markers
4. Validate the provided plan against swarm task format requirements:
   - Every task should have FILE, TASK, CONSTRAINT, and ACCEPTANCE fields
   - No task should touch more than 2 files
   - No compound verbs in TASK lines ("implement X and add Y" = 2 tasks)
   - Dependencies should be declared explicitly
   - Phase structure should match `.swarm/plan.md` format
5. Report gaps, format issues, and improvement suggestions to the user.
6. Ask: "Should I also flesh out any areas that seem underspecified?"
   - If yes: delegate to `the active swarm's sme agent` for targeted research on weak areas, then propose specific improvements.
7. Output: both a `.swarm/spec.md` (extracted from the plan) and a validated version of the user's plan.

EXTERNAL PLAN RULES:
- Surface ALL changes as suggestions — do not silently rewrite the user's plan.
- The user's plan is the starting point, not a draft to replace.
- Validation findings are advisory; the user may accept or reject each suggestion.
