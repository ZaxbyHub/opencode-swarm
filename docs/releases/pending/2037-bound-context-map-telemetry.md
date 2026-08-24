# Bound context-map telemetry storage and reads

## What

PR 09 of the observability sequence. `src/context-map/telemetry.ts` previously
wrote capsule-delegation telemetry to `.swarm/context-telemetry.jsonl` with no
size/count/age budget and read the whole file on every summary — O(n) in total
history. It is now a **bounded single-file store**:

- A versioned manifest header (lifetime folded aggregate + health) plus a
  bounded retained window of recent raw records, all in
  `.swarm/context-telemetry.jsonl`.
- Hard documented ceilings: retained window ≤ 256 KiB / 10,000 entries; records
  older than 30 days pruned from the raw window; every read path capped at
  280 KiB regardless of total history (`CONTEXT_TELEMETRY_LIMITS`). The window
  caps are enforced amortized — a maintenance pass every `checkInterval` writes
  pulls the window back within budget.
- Compaction, legacy migration, and close finalize are **atomic single-file
  rewrites** (write temp + rename), so there is no partial-apply state, no
  double-count, and no history loss even across a crash. Lifetime totals =
  folded aggregate + retained window.
- pre-cutover header-less files migrate incrementally in bounded passes on the
  write/close path (at most `compactMaxBytes` folded per pass, so a large legacy
  tail drains progressively rather than in one big synchronous fold); the
  existing public event and summary field surface is preserved (added additive
  coverage/drop/corrupt disclosure).
- New canonical `context_telemetry_health` telemetry event (counts only —
  accepted/compacted/retained/dropped/corrupt/oldest/newest/bytes) emitted on
  compaction and close. No capsule/query content and no paths ever enter the
  stream.
- `/swarm close` now finalizes and archives the store as a defined, validated
  cut; `/swarm context-map stats` discloses partial migration coverage and drops
  rather than presenting a complete-looking lifetime figure for history that has
  not finished migrating.

## Why

An unbounded append/whole-file-read stream violates the observability
programme's retention and read-amplification contract (PR 08 registry #2036,
parent #1823). The lifetime aggregate keeps totals exact while on-disk bytes and
read work stay within documented bounds under sustained writes.

## Tests

`tests/unit/context-map/telemetry-bounded.test.ts` (new: on-disk ceilings,
bounded-read proof, no double count, corrupt/partial tails, oversized record,
age pruning, multi-project isolation, disk-pressure fail-open, close finalize,
health payload), updated `telemetry.test.ts` / `context-map-stats.test.ts`, the
observability event-contract gates, and a close archive-guard test.

## Closes

Fixes #2037.
