---
name: clarify-spec
description: >
  Full execution protocol for MODE: CLARIFY-SPEC -- resolving spec clarification markers and maintaining spec/planning alignment.
---

# Clarify Spec Protocol

This protocol is loaded on demand by the architect stub in src/agents/architect.ts. The architect prompt keeps only activation, action, and hard safety constraints; the full execution details live here.

### MODE: CLARIFY-SPEC
Activates when: `.swarm/spec.md` exists AND contains `[NEEDS CLARIFICATION]` markers; OR user says "clarify", "refine spec", "review spec", or "/swarm clarify" is invoked; OR architect transitions from MODE: SPECIFY with open markers.

CONSTRAINT: CLARIFY-SPEC must NEVER create a spec. If `.swarm/spec.md` does not exist, tell the user: "No spec found. Use `/swarm specify` to generate one first." and stop.

1. Read `.swarm/spec.md` (read current spec FIRST before making any changes).
2. Scan for ambiguities beyond explicit `[NEEDS CLARIFICATION]` markers:
   - Vague adjectives ("fast", "secure", "user-friendly") without measurable targets
   - Requirements that overlap or potentially conflict with each other
   - Edge cases implied but not explicitly addressed in the spec
   - Acceptance criteria (SC-###) that are not independently testable
3. Present all spec modifications using delta format with ## ADDED/MODIFIED/REMOVED Requirements sections:
   - ## ADDED Requirements: New requirements being added to the spec
   - ## MODIFIED Requirements: Existing requirements being revised (show old vs new)
   - ## REMOVED Requirements: Requirements being deleted (show what was removed)
4. Delegate to `{{AGENT_PREFIX}}sme` for domain research on ambiguous areas before presenting questions.
5. Present questions to the user ONE AT A TIME (max 8 per session):
   - Offer 2–4 multiple-choice options for each question
   - Mark the recommended option with reasoning (e.g., "Recommended: Option 2 because…")
   - Allow free-form input as an alternative to the options
5. After each accepted answer:
   - Immediately update `.swarm/spec.md` with the resolution
   - Replace the relevant `[NEEDS CLARIFICATION]` marker or vague language with the accepted answer
   - If the answer invalidates an earlier requirement, update it to remove the contradiction
6. Stop when: all critical ambiguities are resolved, user says "done" or "stop", or 8 questions have been asked.
7. Report a ## Clarification Summary: total questions asked, requirements added/modified/removed, remaining open ambiguities (if any), and suggest next step (`PLAN` if spec is clear, or continue clarifying).

CLARIFY-SPEC RULES:
- FR-ID increment rule: When adding new requirements, find the highest existing FR-ID and increment from there (FR-001 → FR-002). Never reuse or skip FR-IDs.
- One question at a time — never ask multiple questions in the same message.
- Do not modify any part of the spec that was not affected by the accepted answer.
- Always write the accepted answer back to spec.md before presenting the next question.
- Max 8 questions per session — if limit reached, report remaining ambiguities and stop.
- Do not create or overwrite the spec file — only refine what exists.
