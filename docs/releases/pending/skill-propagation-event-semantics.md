# `fix(hooks)`: skill_propagation events distinguish omitted, none, and inline-body SKILLS shapes

## Summary

- `skill_propagation_warn` fired with `skills_missing: true` on essentially every dispatch that omitted the SKILLS field while skills existed in the project, and the event shape could not distinguish "the dispatch omitted the SKILLS field" from "the SKILLS value did not match a skill" — the two cases need different operator responses (add the field vs. fix the reference).
- Fix: the warn event now carries `skills_field: 'omitted' | 'none'` (a referenced-but-invalid file reference still fails closed earlier in `validateExplicitSkillReferencesBefore`, so the warn never means "reference failed to match"). A present SKILLS value that validated zero file references — the inline-body recovery path, or a bare/free-text value with no path authority — now records a bounded `skill_propagation_inline` trace event (`skills_field: 'inline_or_non_file'`, `inline_recovery: true`) instead of leaving no trace at all.
- Safety: both events are best-effort, non-blocking, and never change gate outcomes; a matched file reference stays completely silent.

## User-facing changes

- `events.jsonl` skill-propagation entries are self-explaining: `skills_field` says which omission flavor fired, and inline-body dispatches are visible as `skill_propagation_inline` instead of being indistinguishable from silent success.

## Migration notes

None. Additive event payload fields; consumers keying on `type`/`skills_missing` are unaffected.

## Discovery context

The consumer-project `swarm_communication_debug.md` §3.5/§7.5 candidate issue (2026-11-23): `skills_missing: true` warnings on nearly every astra_architect→agent dispatch while `available_skills` listed `.claude/skills/keep-the-why/SKILL.md`, with the report noting "the event shape does not distinguish 'dispatch omitted the SKILLS field' from 'the hook failed to match the referenced skill'". Pinned by the updated warn tests and the new inline-trace tests in `tests/unit/hooks/skill-propagation-gate.test.ts`.
