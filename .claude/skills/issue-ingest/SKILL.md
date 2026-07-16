---
name: issue-ingest
audience: swarm-plugin
description: >
  Full execution protocol for MODE: ISSUE_INGEST -- GitHub issue intake, localization, spec generation, and transition to the full fix workflow.
---

# Issue Ingest Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: ISSUE_INGEST
Activates when: user invokes `/swarm issue <url>`; OR architect receives `[MODE: ISSUE_INGEST issue="<url>"]` signal.

Purpose: ingest a GitHub issue, localize root cause, and produce a resolution spec. The issue URL points to a GitHub issue that describes a bug, feature request, or task to be resolved.

Flags parsed from signal:
- `plan=true` → after spec generation, transition to MODE: PLAN (create implementation plan)
- `trace=true` → the issue-trace hook (src/hooks/issue-trace.ts) automatically drives the standard PLAN → CRITIC-GATE → EXECUTE → commit-pr ladder (implies plan=true)
- `noRepro=true` → skip the reproduction step below

#### Phase 1: INTAKE
1. Fetch the issue body using the GitHub CLI (`gh issue view <N> --repo <owner>/<repo> --json title,body,labels,assignees,comments`) or web fetch.
   - If the issue cannot be fetched (404, private repo, no `gh` auth, or the argument resolves to a PR not an issue), report the blocked operation explicitly and do not proceed on empty intake; fall back to any pasted issue text the user provided. Closed-issue cases proceed but note the closed state.
2. Read `.swarm/issue-reference.json` as the authoritative source for the issue URL, owner, repo, number, and flags (`plan`/`trace`/`noRepro`). If absent, fall back to the URL from the mode signal string.
3. Parse the issue into a normalized **Intake Note** with four required fields:
   - **Observed behavior**: what the issue reports
   - **Expected behavior**: what should happen instead
   - **Reproduction steps**: how to trigger the issue (may be absent; flag with `[NEEDS REPRO]` if missing)
   - **Environment**: platform, version, configuration context
4. If any required field is missing and cannot be inferred from context, flag as `[NEEDS REPRO]`.
5. Attempt a minimal reproduction of the reported issue: record the exact commands and their output. Skip this step when `noRepro=true` (set via `--no-repro`); in that case, note that reproduction was skipped and proceed on the issue text alone.
6. Ask the user clarifying questions one at a time, max 6 per intake, when the issue text is ambiguous; otherwise flag the item with markers like `[NEEDS REPRO]` or `[NEEDS CLARIFICATION]` and proceed.
7. Exit when the Intake Note is complete or all missing fields are flagged.

#### Phase 2: LOCALIZATION
1. Delegate to `the active swarm's explorer agent` to scan the codebase for code areas related to the issue's observed behavior.
2. Build 2–5 candidate hypotheses for root cause, each with:
   - **Location**: file(s) and function(s) most likely responsible
   - **Confidence**: composite score (stack-trace match 0.4, recency 0.25, call-graph proximity 0.2, test-failure correlation 0.15)
   - **Falsifiability**: a specific test or observation that would disprove this hypothesis
3. Validate top-3 hypotheses in parallel using targeted `the active swarm's sme agent` consultations.
4. Prune to a single root cause hypothesis with supporting evidence.
5. Exit when a root cause is identified with ≥70% confidence, or when all hypotheses are exhausted (report ambiguity).

#### Phase 3: SPEC GENERATION
0. Include a **Root Cause** section derived from Phase 2 localization results: concise statement of the identified root cause, location, and confidence score; the `location` field (file/function from Phase 2 localization) is the sole exception to the no-implementation-detail rule. Include a **Fix Strategy** section at product/behavior level (what the fix must accomplish, not how to implement it).
0a. Include a `## Source Issue` section at the top of `.swarm/spec.md` containing the GitHub issue URL and number, read from `.swarm/issue-reference.json`.
1. If `.swarm/spec.md` already exists, route through MODE: SPECIFY step 1's classification (overwrite / refine / archive / non-shadowing check) before writing — do not clobber an existing spec. (This protects the drift-gate which consumes spec.md.)
2. Generate `.swarm/spec.md` using the same SPEC CONTENT RULES as MODE: SPECIFY:
   - WHAT users need and WHY — never HOW to implement
   - FR-### / SC-### numbering, Given/When/Then scenarios
   - No technology stack, APIs, or code structure
   - `[NEEDS CLARIFICATION]` markers only for items that survive the clarification funnel: inventory all material uncertainties without numeric cap → classify each (self_resolved/critic_resolved/research_needed/user_decision/deferred_nonblocking) — **Overconfidence guard:** if the default is not directly supported by user request, spec, or recorded context, classify as `user_decision` rather than `self_resolved` → consult critic_sounding_board — critic responds per SoundingBoardVerdict: UNNECESSARY→DROP, RESOLVE→RESOLVE, REPHRASE→REPHRASE, APPROVED→ASK_USER — **always-surface protection:** always-surface categories must not receive UNNECESSARY/DROP; override to APPROVED/ASK_USER → record resolved items as assumptions → surface only survivors as markers with decision packet format (grouped by category, recommended defaults, blocking vs optional markers)
   - **Important:** Apply a fixed 5-minute protocol budget to `research_needed`. If research does not complete within 5 minutes, automatically reclassify the item to `user_decision` with a note that research was incomplete, then surface it to the user.
3. Cross-reference the spec against the issue's expected behavior to ensure alignment.
4. If the issue is a bug: spec must describe the correct behavior, not the broken behavior.
5. If the issue is a feature: spec must describe the user-facing outcome, not the implementation.
6. Carry forward any `[NEEDS REPRO]` / `[NEEDS CLARIFICATION]` flags from Phase 1 into the spec as open questions; do not silently drop them.
7. QA GATE SELECTION: Ask user which QA gates to enable (same dialogue as MODE: SPECIFY). Write to `.swarm/context.md` under `## Pending QA Gate Selection`.

#### Phase 4: TRANSITION
Based on flags:
- No flags → report spec summary and suggest `PLAN` or `CLARIFY-SPEC`
- `plan=true` → transition to MODE: PLAN using the generated spec
- `trace=true` → the issue-trace hook (`src/hooks/issue-trace.ts`) automatically emits `[MODE: PLAN]` after spec generation. The standard PLAN → CRITIC-GATE → EXECUTE ladder follows deterministically.

RULES:
- One question per message in INTAKE dialogue (max 6 questions)
- Hypotheses must be falsifiable — no unfalsifiable hypotheses
- Spec must be independently testable — each FR must have a verification path
- The issue URL is already sanitized by the issue command — do not re-sanitize
