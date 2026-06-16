# Knowledge system wave 0/1 hardening

- Added safer test temp cleanup helpers and documented bounded recursive
  deletion rules in the writing-tests skill.
- Hardened knowledge lifecycle behavior across dedicated enrichment quota routing,
  validator false positives, event-sourced counter retention, application-log
  caps, skill feedback idempotency, generated-skill maturity, hive archive
  support, priority-aware cap eviction, inactive hive-promotion filtering,
  cold-start scoring, reviewer `TASK:` attribution, and safer recursive test
  cleanup.
- Split curator/close-time/unactionable-hardening enrichment calls onto
  `.swarm/knowledge-enrichment-quota.json`, separate from the skill-improver
  proposal quota.
- Added generated-skill docs and archived the stale root knowledge audit under
  `docs/archive/`.

Migration: operators who previously treated `skill_improver.max_calls_per_day`
as the enrichment budget should move that limit to `knowledge.enrichment`.
`skill_improver.max_calls_per_day` now remains scoped to proposal/reviser work,
while curator, close-time, micro-reflector, and hardening enrichment use
`knowledge.enrichment`.
