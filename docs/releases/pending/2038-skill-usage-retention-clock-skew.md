# Skill-usage retention: clamp cutoff against poisoned future timestamps

## What

Follow-up to issue #2038 (skill-usage hard global bound), fixing a
retention/compaction bug caught by later review of PR #2347 after it had
already merged.

`applyRetention` in `src/hooks/skill-usage-log.ts` anchors its age-based
eviction cutoff to the newest entry's timestamp in the batch, so repeated
compaction passes stay deterministic and idempotent. A single future-dated
entry — for example a broken system clock at write time, not something an
attacker can trigger, since every production writer stamps
`new Date().toISOString()` — became that anchor, inflating the cutoff and
causing every legitimately-recent entry in `.swarm/skill-usage.jsonl` to be
evicted in the same compaction pass.

## Why

The fix clamps the anchor with `Math.min(newestMs, Date.now())` before
subtracting the retention window (`maxAgeMs`, 90 days). This is a no-op for
all normal data — the newest entry's timestamp is never ahead of wall-clock
now under regular operation — so it does not reintroduce wall-clock
dependence into the retention window's idempotency guarantee. It only
changes behavior on the anomalous poisoned-timestamp path.

## Migration

No migration required. Existing `.swarm/skill-usage.jsonl` logs are
unaffected unless they already contain a future-dated entry, in which case
the next compaction pass now retains the legitimately-recent entries it
previously would have mass-evicted.

## Known caveats

None.
