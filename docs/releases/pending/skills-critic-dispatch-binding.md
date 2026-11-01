# `fix(skills)`: bind the critic dispatch to the harness's pinned cross-model critic

## Summary

- Added a **"Critic role binding (all profiles)"** paragraph to the Phase 8 Critic Challenge of `.opencode/skills/swarm-pr-review/SKILL.md` — the critic dispatch must resolve to the harness's pinned cross-model critic agent type when one exists (model-independent from the reviewer where the harness exposes model identity); a generic agent type is a fallback only when no pinned type exists or the pinned dispatch fails, and the substitution is disclosed in the synthesis as a degraded independence gate
- The policy explicitly binds harness adapters: a condensed/installed skill copy whose routing note names a generic agent for this role without the pinned-first rule is defective and must be corrected, not followed

## User-facing changes

Skill behavior clarification only — orchestrators following the installed condensed copies stop resolving the critic role to a generic agent when a pinned critic specialist exists on the roster.

## Migration notes

None required. Installed copies that carry a generic-agent critic routing note should be corrected to the pinned-first policy (the canonical paragraph is the reference wording).
