# `fix(skills)`: align compliance verdict vocabulary across producers and consumers

## Summary

- The sole producer of skill compliance verdicts (`skill-propagation-gate.ts`) writes the canonical spelling `'violated'` (lowercased regex capture), but six consumer comparisons in `skill-usage-log.ts` and `curator.ts` filtered on the string `'violation'`, which no producer ever writes.
- As a result, negative skill feedback (confidence decay) and the 30% violation-rate auto-retire threshold never fired.
- All consumer comparisons now use the canonical `'violated'` spelling. A `normalizeComplianceVerdict()` helper maps legacy on-disk entries (`'violation'`) to `'violated'` on both read paths, so pre-existing `skill-usage.jsonl` data is handled without manual migration.

## User-facing changes

- Skill compliance feedback now works as intended: a recorded `SKILL_COMPLIANCE: VIOLATED` verdict produces the expected negative confidence delta, and skills exceeding the violation-rate threshold are eligible for auto-retire again.
- `getSkillUsageStats` (`stats.violation`) now counts violated entries.

## Migration notes

No action required. Legacy on-disk `skill-usage.jsonl` entries carrying the old `'violation'` spelling are normalized to `'violated'` automatically on read.

## Breaking changes

None.

## Known caveats

- The producer vocabulary (`'compliant' | 'partial' | 'violated'`) is unchanged; only consumer comparisons were corrected.
- Found during the 2026-06-12 knowledge/skill system end-to-end review (issue #1281).
