# `fix(skills)`: bind the critic dispatch to the harness's pinned cross-model critic

## Summary

- Added a **"Critic role binding (all profiles)"** paragraph to the Phase 8 Critic Challenge of `.opencode/skills/swarm-pr-review/SKILL.md` — the critic dispatch must resolve to the harness's pinned cross-model critic agent type when one exists (model-independent from the reviewer where the harness exposes model identity); a generic agent type is a fallback only when no pinned type exists or the pinned dispatch fails, and the substitution is disclosed in the synthesis as a degraded independence gate
- The policy explicitly binds harness adapters: a condensed/installed skill copy whose routing note names a generic agent for this role without the pinned-first rule is defective and must be corrected, not followed

## User-facing changes

Skill behavior clarification only — orchestrators following the installed condensed copies stop resolving the critic role to a generic agent when a pinned critic specialist exists on the roster.

## Migration notes

None required. Installed copies that carry a generic-agent critic routing note should be corrected to the pinned-first policy (the canonical paragraph is the reference wording).

The canonical grows by 14 lines (1692 -> 1705), so the progressive-disclosure ratchet baselines pinning `.opencode/skills/swarm-pr-review/SKILL.md` are bumped to 1705 in `tests/unit/skills/progressive-disclosure-ratchet.test.ts` and `tests/unit/skills/swarm-pr-review-partial-settlement-2859.test.ts`. The paragraph is binding policy that installed copies must carry inline, so it stays in the canonical rather than moving into `references/`; the standing issue-#2131 disclosure debt for this skill grows by the same 14 lines.
