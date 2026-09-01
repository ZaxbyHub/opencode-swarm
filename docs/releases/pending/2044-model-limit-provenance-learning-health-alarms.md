---
sig: feat
component: opencode-swarm
---

# Model-limit provenance + learning/operations health alarms (#2044)

## What you see after updating

- **`context_status` now tells you WHERE your context limit came from.** Every response gains
  `modelLimitSource` (`host` | `override` | `provider_cap` | `native` | `fallback`),
  `modelLimitResolution` (the exact resolution rung), and `fallbackActive` — so a "95% used"
  reading against a stale 128k fallback denominator is finally distinguishable from real
  exhaustion. Override keys are matched case/whitespace-insensitively, and invalid override
  values (zero/NaN/negative) are skipped and surfaced with a reason instead of silently
  disabling your config.
- **`/swarm status` gains a "Learning Health" section** and **`/swarm diagnose` gains a
  "Learning health" check**, fed by a new bounded-window alarm registry
  (`.swarm/learning-health.json`) covering eight families: repeated dead context headroom
  (with bad-denominator attribution), model-limit fallback active, retrieval → receipt →
  application-outcome liveness, eligible-role participation gaps, promoted-tier
  fixture/synthetic share vs field evidence, close-archive empty/invalid mismatches,
  background recovery-ledger pressure near the 4 MiB bound, and store compaction
  drop/corruption coverage across the six audited stores.
- **New `learning_health_alarm` telemetry event** — counts, closed-vocabulary enums, and
  16-hex salted session refs only; no raw session IDs, paths, queries, or content.
- Knowledge-injection skip diagnostics now stamp the context that WAS available at each
  early return (message count, model identity, phase) plus an explicit missing-reason list.

## Behavior notes

- Alarm thresholds are documented constants (windows 10 min–7 d by family, cooldowns with
  hysteresis); no new config keys.
- The registry persists alarm transitions and compact per-scope counters only — never
  invocation-owned retry/circuit state — and survives restarts.
- The receipt-liveness alarm never fires before the application gate's own staleness
  escalation, and treats gate releases as authoritative closures.

## Runtime observability notes

- After a restart, a rehydrated active alarm intentionally stays quiet for one
  cooldown interval before it may re-emit `sustained` — emission cadence resets
  per process; the persisted transition history stays intact.
- Session-scoped alarms key state by project-prefixed salted session refs; in a
  single-process single-project OpenCode host this is exact. Multi-project
  same-process aggregation is a known follow-up concern for the sink work (#2047).
