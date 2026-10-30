# Receipt-footer aggregate-bounds test no longer times out under coverage

## What changed

The per-test timeout on `bounds aggregate large valid receipts while retaining
every anti-replay tombstone` in
`tests/unit/tools/dispatch-lanes-pr-review-receipt-footer.test.ts` was raised
from 30 000 ms to 60 000 ms, matching the coverage gate's own per-test budget
(`bun test --isolate --coverage --coverage-reporter=lcov --timeout 60000` in
`scripts/ci/run-coverage-gate.sh`). A new lockstep pin
(`tests/unit/scripts/ci/ci-coverage-timeout-lockstep.test.ts`) fails CI if the
test's explicit cap ever diverges from the gate's budget. No production code
changed.

## Why

A per-test timeout overrides `bun test --timeout`, so the coverage gate never
got to apply its own 60 s per-test budget to this test: the old 30 s cap
killed it first. The corpus is intentionally large (80 delegations × 180
review-item IDs through real SQLite-backed transitions plus two forced
compactions). Between 2026-10-22 and 2026-10-27 the flake detector recorded
**nine** detections of this file (seven via #3264, two via #3263), including
hard shard failures on 2026-10-25 (run 40152945255, coverage-shard (5)),
three same-day failures on 2026-10-26 (runs 40253942931, 40255972796 and
40282456510 — coverage-shard (6) for all three, five green merge-group CI
runs separating the last two), and a 3/3-attempt hard failure on
2026-10-27 (run 40449933636, coverage-shard (5)). Coverage shards are
Linux-only and shard indices are a per-run partition.
Every observed figure (30.2–32.0 s) is a **censored elapsed time at the kill**
— no instrumented run of this test has completed on CI — so the 60 s cap is
sized at ~1.9× above the highest censored observation, equals the gate's own
budget, and the first post-fix green run yields the first true completed
measurement (the merge-group coverage shards run on the self-hosted Linux
fleet).

## Migration steps

None. The change is a test-file timeout raise plus a lockstep pin.

## Known caveats

- This file is a repeat offender (nine detections), and quarantine was still
  deliberately rejected: the coverage gate reads only the general ledger, so
  an entry would also drop the file from the ubuntu unit shards and lose real
  coverage of `src/background/pr-review-collection-receipt.ts`. If the test
  ever exceeds 60 s instrumented, the remedy is shrinking the corpus (while
  keeping the shedding property asserted), not raising the cap again.
- The other #3263 candidates: five of the six issue-body files are the
  pre-fix `.swarm/` checkout-posture wave root-fixed by the #3248 cohort
  (named with their detection counts in `scripts/ci/run-coverage-gate.sh`);
  `tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts` is a
  CORE-TREE candidate that still awaits its per-file human decision on #3263
  (rule C of `scripts/ci/detect-and-quarantine-flakes.sh`).
  `tests/unit/commands/archive-dry-run.test.ts` was detected twice (2026-10-18
  via #3264 run 39108262782; 2026-10-26 via #3263 run 40282456510) as a
  passed-on-retry Windows teardown flake whose raw-`rmSync` root cause is
  tracked under open #3252; it gets no ledger entry unless recurrence beyond
  #3252's fix warrants one.
