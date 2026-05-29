# Clarification Funnel: Replace Max-3 Caps with Critic-Reviewed Decision Packets

## Motivation
The architect prompt and skill files contained an arbitrary "max 3" / "up to 3" cap on clarification questions. This cap could suppress important user decisions in complex features while being too generous for simple ones. The cap was not grounded in any user research or calibration data.

## Behavioral Change
- **Before**: The architect would "Ask up to 3 clarifying questions" with no structured process for determining which questions mattered most.
- **After**: The architect runs a 4-stage clarification funnel:
  1. **Inventory** all material uncertainties without numeric cap
  2. **Classify** each as self_resolved, critic_resolved, research_needed, user_decision, or deferred_nonblocking
  3. **Consult critic_sounding_board** — the critic can DROP, RESOLVE, REPHRASE, or ASK_USER for each item
  4. **Surface** only surviving user decisions as a structured decision packet (grouped by category, with recommended defaults, blocking vs optional markers)

The funnel includes 13 always-surface categories (scope, data loss, security, compatibility, breaking changes, dependency additions, deprecation, cross-platform impact, cost/performance, UX, rollout, QA policy, advisory-vs-blocking) that MUST be surfaced regardless of critic feedback, with a hard constraint preventing the critic from DROPping them.

## Key Files Changed
- `src/agents/architect.ts`: Removed "Ask up to 3 questions" from CLARIFY mode detection and hard constraints; added critic_sounding_board to SKILL AGENT TARGET RENDERING
- `.opencode/skills/clarify/SKILL.md` + `.claude` mirror: Full 4-stage funnel protocol (was 13-line stub)
- `.opencode/skills/specify/SKILL.md` + `.claude` mirror: Inline funnel reference
- `.opencode/skills/brainstorm/SKILL.md` + `.claude` mirror: Inline funnel reference
- `.opencode/skills/issue-ingest/SKILL.md` + `.claude` mirror: Inline funnel reference
- `.opencode/skills/plan/SKILL.md` + `.claude` mirror: 86-line CLARIFICATION FUNNEL section

## Risk Mitigation
- **Overconfidence guard**: self_resolved classification requires evidence directly from user request, spec, or recorded context — unsupported defaults must be classified as user_decision
- **DROP protection**: Always-surface categories cannot be DROPped by the critic — only REPHRASE or ASK_USER allowed
- **Assumptions recording**: All resolved uncertainties must be recorded as explicit assumptions (in the spec, plan, or .swarm/context.md depending on mode) — silently dropping is a protocol violation
- **No session cap**: The architect MUST NOT drop unresolved decisions because of a session question cap
