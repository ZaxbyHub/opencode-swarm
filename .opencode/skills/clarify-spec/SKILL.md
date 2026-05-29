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
4. Delegate to `the active swarm's sme agent` for domain research on ambiguous areas before presenting questions.
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

### Scoped Funnel Protocol (CLARIFY-SPEC only)

CLARIFY-SPEC handles **already-surfaced** `[NEEDS CLARIFICATION]` markers and spec ambiguities — it does not perform open-ended discovery of new uncertainties. The full four-stage clarification funnel (inventory, classify, consult critic, surface) described in the clarify skill applies to MODE: CLARIFY and MODE: PLAN, not here.

However, before surfacing each marker question to the user, CLARIFY-SPEC MUST:

1. **Consult `critic_sounding_board`** with the candidate marker question and surrounding spec context to check whether the question wording can be improved or the item can be resolved from existing context.
2. **Apply the overconfidence guard:** If the critic supplies a `RESOLVE` verdict with a default answer, but that default is not directly supported by user request, spec, or recorded context, classify the item as `user_decision` rather than `self_resolved`.
3. **Apply always-surface protection:** If the marker belongs to an always-surface category (scope boundaries, destructive behavior, security/privacy, backward compatibility, breaking API changes, new dependencies, deprecations, cross-platform impact, cost/performance tradeoffs, user-visible UX, rollout strategy, QA gates), the item MUST NOT receive `UNNECESSARY`/`DROP` from the critic — override to `APPROVED`/`ASK_USER`.

Critic verdict mapping (see `src/agents/critic.ts` `SoundingBoardVerdict`): `UNNECESSARY`→DROP, `RESOLVE`→RESOLVE, `REPHRASE`→REPHRASE, `APPROVED`→ASK_USER.

This scoped protocol is lighter than the full funnel because CLARIFY-SPEC starts from known markers rather than open uncertainty inventory, but it still protects against overconfident self-resolution and premature dropping of important questions.
