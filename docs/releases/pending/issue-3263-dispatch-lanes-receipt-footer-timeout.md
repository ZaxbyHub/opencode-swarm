# Receipt-footer aggregate-bounds test no longer times out under coverage

## What changed

The per-test timeout on `bounds aggregate large valid receipts while retaining
every anti-replay tombstone` in
`tests/unit/tools/dispatch-lanes-pr-review-receipt-footer.test.ts` was raised
from 30 000 ms to 60 000 ms, with a comment documenting why the cap must
budget for the coverage-instrumented runtime. No production code changed.

## Why

A per-test timeout overrides `bun test --timeout 60000`, so the coverage gate
(`scripts/ci/run-coverage-gate.sh`) never got to apply its own 60 s per-test
budget to this test. The corpus is intentionally large (80 delegations × 180
review-item IDs through real SQLite-backed transitions plus two forced
compactions): it runs ~23 s bare and ~28 s under coverage instrumentation on a
fast host, but 31 095 ms on GitHub's shared runners — past its own 30 s cap.
That hard-failed `coverage-shard (6)` in two consecutive merge-group runs
(runs 40255972796 and 40282456510, 2026-10-26, detected via issues #3264 and
#3263), then squeaked under the cap in the next two runs — a marginal-timeout
oscillation that will keep evicting merge-queue entries under load. 60 s
matches the gate's own per-test budget with ~2x headroom over the slowest
observed instrumented run.

The other seven quarantine candidates in #3263 get no quarantine entry: the
six files in the issue body are the pre-fix `.swarm/` checkout-posture wave
root-fixed by the #3248 cohort fixes (the coverage gate now pre-creates
`.swarm/coverage-gate/`), and `tests/unit/commands/archive-dry-run.test.ts`
was a single passed-on-retry Windows flake with no recurrence, tracked with
the Windows teardown class under #3252.

## Migration steps

None. The change is a test-file timeout bump only.

## Known caveats

- If the test ever exceeds 60 s instrumented, the fix is shrinking the corpus
  (while keeping the shedding property asserted), not raising the cap again.
- Quarantining this file was deliberately rejected: the general ledger is the
  only one the coverage gate reads, so an entry would also drop the file from
  the ubuntu unit shards and lose real coverage of
  `src/background/pr-review-collection-receipt.ts`.
