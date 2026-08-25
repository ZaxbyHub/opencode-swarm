# CI: sharded coverage gate + 90-minute merge-queue timeout (issue #2341)

## What changed

Green pull requests were being evicted from the merge queue with
`checks_timed_out` through no fault of their own. The merge-queue budget
(`check_response_timeout_minutes: 60`, and the clock starts at **enqueue**,
including queue wait) was smaller than the CI graph's critical path, whose
long pole was the `coverage` gate: a single serial job running the entire
gated test suite per-file under coverage (~48 minutes measured on the
PR #2313 eviction — it started 9 minutes after enqueue and succeeded at
47.8 minutes, leaving the group minutes of margin at position 1 and none
behind anything else in the queue).

- **Ruleset (main branch protection, 17809658):** `check_response_timeout_minutes` raised 60 → 90, and `unit-passed` added to the required status checks. The second change fixes the eviction mode actually observed on PR #2313: when a single unit matrix cell failed, the required `integration`/`smoke` checks were *skipped* (never reported), and because the failing cells themselves were not required checks, the queue could only sit and time out for the full window. `unit-passed` fails fast in exactly that situation, converting a silent 60-minute eviction into an immediate `checks_failed` eviction.
- **Coverage gate sharded:** the single `coverage` job is now a `coverage-shard` matrix (6 ubuntu shards, the same round-robin partition as the `unit` job, so coverage shard N measures exactly the files of `unit (ubuntu-latest, N)`) plus a `coverage` aggregator job that keeps the required-check name, merges every shard's lcov report with `scripts/ci/merge-lcov.mjs`, and enforces the 65.00% line-coverage threshold **once** over the union. The aggregator fails closed three ways (shard-matrix result check, zero-artifact download error, explicit per-shard presence loop) — a dropped shard can never silently shrink the measured set. Per-shard wall clock is ~12 minutes
(typical, cached; bounded by a 30-minute job timeout) instead of a ~48-minute
serial run, so the coverage leg is no longer the merge-group long pole at any
queue position.
- **Structural guards extended:** `tests/unit/scripts/ci/ci-coverage-sharding.test.ts` pins the new graph (CI-004 "coverage never behind unit" inherited by the shards, shard-count parity across unit/coverage/aggregator, ubuntu-only partition pinning, fail-closed aggregator, single-sourced threshold literal, event guards on every aggregator step so pull_request and release-please runs stay green), and the existing `ci-yml-integration.test.ts` CI-004 assertions moved there.
- **Docs corrections:** `TESTING.md` and `contributing.md` still documented a 41.48% coverage threshold — the actual floor has been 65.00% since the issue #1778 H4 recalibration. Both now state the real threshold and describe the sharded gate; `unit-passed` is listed in the required-checks table.

## Why this is a strengthening, not a loosening

The threshold, the measured set, and the per-file coverage isolation
(`bun test --isolate`, issue #1712) are all unchanged; only the wall-clock
distribution changed. Merging shard lcov reports with max-union line-hit
semantics is equivalent to the previous flat merge, and the aggregator rejects
an incomplete shard set rather than measuring a smaller denominator.

Post-fix queue math: the merge-group critical path is the unit chain —
quality (~2 min) → unit matrix (Windows pole ~20-25 min) → integration
(~5-10 min) → smoke (~10 min) ≈ 40-50 minutes — with the coverage leg
(shards ~12 min + aggregator ~2, starting after quality) fully in parallel,
versus a 90-minute from-enqueue budget at any queue position (~2x margin).
Before: coverage alone ended ~48-57 min after enqueue with the smoke chain
still to run.

Known caveat (pre-existing, tracked in #2344): within an otherwise-green
coverage shard, a test file for which bun produces no lcov report only logs a
warning — that file's lines drop out of the measured denominator. The
aggregator's fail-closed checks bound this to per-file granularity; a shard
that produces no lcov at all still fails the gate.

## Migration

None. Contributors see faster merge-group runs and the same required checks
(`coverage` remains the single coverage gate).
