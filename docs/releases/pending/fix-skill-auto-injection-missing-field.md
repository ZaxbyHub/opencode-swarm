# `fix(skill-propagation)`: auto-inject skills when architect omits SKILLS field

## Summary

Fixes a bug where the architect delegated to skill-capable agents (coder, test_engineer,
reviewer, etc.) without a SKILLS field and the skill auto-injection in `index.ts` silently
did nothing — leaving subagents unaware of available project skills.

**Root cause:** `skillPropagationGateBefore` had two defects:

1. The scoring block guarded itself with `if (skillsValue && ...)` — scoring only ran
   when a SKILLS field was *already present*, so it produced no ranked candidates when
   SKILLS was missing.
2. The warning-path return (`SKILLS missing, enforce=false`) always returned
   `recommendedSkills: undefined` — the field that `index.ts` step 8 checks to decide
   whether to auto-inject.

Combined, the auto-injection gate in `index.ts` (`if (skillResult.recommendedSkills &&
skillResult.recommendedSkills.length > 0)`) never fired on missing-SKILLS delegations,
even though routing config (`skill-routing.yaml`) was present with explicit skill paths.

**Fix (two lines in `src/hooks/skill-propagation-gate.ts`):**

- Removed `skillsValue &&` from the scoring condition — scoring now runs whenever skills
  exist in the project and the field is not explicitly `none`.
- Changed the warning-path return to include `recommendedSkills: scored` instead of
  `recommendedSkills: undefined` — giving `index.ts` the ranked candidates it needs.

`SKILLS: none` (explicit opt-out) is unaffected: the scoring condition already excluded
it via `skillsValue.toLowerCase() !== 'none'`, and `index.ts` further guards against
injection when `existingSkills` is non-empty.

## User-facing changes

- The architect agent now **automatically injects the top 5 relevant skills** (score ≥ 0.5)
  into delegation prompts when the SKILLS field is omitted.  Skills in
  `.opencode/skill-routing.yaml` receive a boosted score of 0.9 and are prioritised.
- Projects with usage history in `.swarm/skill-usage.jsonl` additionally get
  history-weighted ranking so frequently-used, high-compliance skills surface first.
- Delegations that already have a SKILLS field, or that explicitly say `SKILLS: none`,
  are unchanged.

## Migration notes

None required. Existing skill-routing.yaml configurations and `SKILLS:` fields work
without modification.
