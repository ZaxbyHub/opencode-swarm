# Skill Compliance Vocabulary Unification

## What changed

Fixed a critical vocabulary mismatch in skill compliance verdict handling where producers write `'violated'` but consumers filtered for the non-existent `'violation'` string. This prevented:
- Negative confidence feedback from being applied to skills with violated verdicts
- Auto-retire based on violation rate thresholds from triggering
- Statistics from correctly counting violations

## Why

The `SKILL_COMPLIANCE: VIOLATED` pattern is lowercased to `'violated'` in the producer (`skill-propagation-gate.ts:1010`), but all consumers (`skill-usage-log.ts`, `curator.ts`) incorrectly filtered for `'violation'`. This created a silent failure mode where violated skills could never trigger the documented feedback mechanisms.

## Impact

- Skills with `SKILL_COMPLIANCE: VIOLATED` verdicts now correctly decay confidence by `-0.1` via `applySkillUsageFeedback`
- Skills exceeding 30% violation rate can now be auto-retired by the curator
- `getSkillUsageStats` correctly counts `violated` entries

## How to use

No user action required. This is an internal fix that enables previously broken features.

## Migration

No migration required. The vocabulary change is transparent and the data format remains the same (`'violated'` is the correct value already produced).

## Known caveats

None.
