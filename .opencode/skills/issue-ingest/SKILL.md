---
name: issue-ingest
description: >
  Full execution protocol for MODE: ISSUE_INGEST -- GitHub issue intake, localization, spec generation, and transition to planning or tracing.
---

# Issue Ingest Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: ISSUE_INGEST
Activates when: user invokes `/swarm issue <url>`; OR architect receives `[MODE: ISSUE_INGEST issue="<url>"]` signal.

Purpose: ingest a GitHub issue, localize root cause, and produce a resolution spec. The issue URL points to a GitHub issue that describes a bug, feature request, or task to be resolved.

Flags parsed from signal:
- `plan=true` → after spec generation, transition to MODE: PLAN (create implementation plan)
- `trace=true` → after plan, delegate to swarm-implement skill for full fix-and-PR workflow (implies plan=true)
- `noRepro=true` → skip reproduction verification step

#### Phase 1: INTAKE
1. Fetch the issue body using the GitHub CLI (`gh issue view <N> --repo <owner>/<repo> --json title,body,labels,assignees,comments`) or web fetch.
2. Parse the issue into a normalized **Intake Note** with four required fields:
   - **Observed behavior**: what the issue reports
   - **Expected behavior**: what should happen instead
   - **Reproduction steps**: how to trigger the issue (may be absent; flag with `[NEEDS REPRO]` if missing)
   - **Environment**: platform, version, configuration context
3. If any required field is missing and cannot be inferred from context, flag as `[NEEDS REPRO]`.
4. If `--no-repro` flag is set, skip reproduction verification and proceed with available information.
5. Exit when the Intake Note is complete or all missing fields are flagged.

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
0. Include a **Root Cause** section derived from Phase 2 localization results: concise statement of the identified root cause, location, and confidence score. Include a **Fix Strategy** section at product/behavior level (what the fix must accomplish, not how to implement it).
1. Generate `.swarm/spec.md` using the same SPEC CONTENT RULES as MODE: SPECIFY:
   - WHAT users need and WHY — never HOW to implement
   - FR-### / SC-### numbering, Given/When/Then scenarios
   - No technology stack, APIs, or code structure
     - `[NEEDS CLARIFICATION]` markers only for items that survive the clarification funnel: inventory all material uncertainties without numeric cap → classify each (self_resolved/critic_resolved/research_needed/user_decision/deferred_nonblocking) — **Overconfidence guard:** if the default is not directly supported by user request, spec, or recorded context, classify as `user_decision` rather than `self_resolved` → consult critic_sounding_board — critic responds per SoundingBoardVerdict: UNNECESSARY→DROP, RESOLVE→RESOLVE, REPHRASE→REPHRASE, APPROVED→ASK_USER — **always-surface protection:** always-surface categories must not receive UNNECESSARY/DROP; override to APPROVED/ASK_USER → record resolved items as assumptions → surface only survivors as markers with decision packet format (grouped by category, recommended defaults, blocking vs optional markers)
     - **Important:** If research is ongoing, monitor the timeout configured in `.swarm/config.json` under `research_needed_timeout_ms` (default: 300000ms / 5 minutes). If research does not complete before the timeout expires, automatically reclassify the item to `user_decision` with a note that research was incomplete, then surface it to the user. This prevents the clarification funnel from stalling while waiting for external research.
 2. Cross-reference the spec against the issue's expected behavior to ensure alignment.
3. If the issue is a bug: spec must describe the correct behavior, not the broken behavior.
4. If the issue is a feature: spec must describe the user-facing outcome, not the implementation.
5. QA GATE SELECTION: Ask user which QA gates to enable (same dialogue as MODE: SPECIFY). Write to `.swarm/context.md` under `## Pending QA Gate Selection`.

#### Phase 4: TRANSITION
Based on flags:
- No flags → report spec summary and suggest `PLAN` or `CLARIFY-SPEC`
- `plan=true` → transition to MODE: PLAN using the generated spec
- `trace=true` → transition to MODE: PLAN, then delegate to swarm-implement skill for full fix workflow

RULES:
- One question per message in INTAKE dialogue (max 6 questions)
- Hypotheses must be falsifiable — no unfalsifiable hypotheses
- Spec must be independently testable — each FR must have a verification path
- The issue URL is already sanitized by the issue command — do not re-sanitize
