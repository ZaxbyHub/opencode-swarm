# Fix: SKILL_COMPLIANCE regex pattern broken by stray space

## What changed

Restored the regex pattern for parsing skill compliance verdicts in `src/hooks/skill-propagation-gate.ts:887`.

The pattern had a literal space before the end-of-line anchor (`\s*$`), which could never match because the regex is tested against `line.trim()` (which removes trailing whitespace). This broke the entire skill-compliance feedback loop.

## Why

Commit c2de93a accidentally inserted the stray space while fixing JSDoc. The regex pattern now correctly matches:

- `SKILL_COMPLIANCE: COMPLIANT`
- `SKILL_COMPLIANCE: PARTIAL — notes`
- `SKILL_COMPLIANCE: VIOLATED - notes`

All in the exact format the reviewer agent emits.

## Impact

Restores the skill-compliance feedback loop:

- `SKILL_COMPLIANCE` verdicts are now recorded to `.swarm/skill-usage.jsonl`
- Compliance rate is now properly calculated for skill scoring
- Knowledge confidence reinforcement via skill usage is now functional
- Curator's 30%-violation auto-retire can now trigger

## Migration

No migration required. This is a pure bug fix that restores intended behavior. Previous missing compliance entries cannot be recovered, but future entries will be recorded correctly.
