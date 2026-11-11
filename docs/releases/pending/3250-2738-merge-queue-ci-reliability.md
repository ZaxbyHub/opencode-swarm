---
"issue": "3250, 2738"
---

## CI: coverage-aggregator diagnostics discriminate their failure layer; macOS crash fixture terminates the process group (#3250, #2738)

- The merge-queue `coverage` aggregator's fail-closed error now names the
  upstream `quality` job result (via a direct `needs` edge and an env var),
  so a cascade failure identifies the layer that caused it instead of only
  the shard-matrix verdict.
- The aggregator's final `Upload coverage report` step now runs only when the
  merge step actually executed (`steps.merge-coverage.outcome != 'skipped'`).
  Previously the unconditional `if: always()` upload warned
  "No files were found with the provided path: coverage/lcov.info" on every
  failed aggregation — a misleading headline that misattributed upstream
  failures (forensics: 11 of 14 signature runs were quality-job
  pending-fragment failures, 3 were genuine shard test failures; no run ever
  lost a file) to a missing file. The warning firing again now means a real
  merge-ran-but-no-file event. Reports from threshold-failure merges are
  still uploaded — they are the diagnostic.
- The repository-validation crash fixture now signals its own process group
  (`kill -KILL 0`) instead of a parent-pid target that depended on Bun's
  worker topology. On macos-latest / Bun 1.3.13 the old target missed the
  spawned `bun test` process, which observed a worker failure, exited 0, and
  made the harness record `passed` (9/9 deterministic CI failures). The
  crash arm also fails with an explicit "child survived the delivered
  signal" diagnostic if the termination ever misses again.
- The macOS quarantine entry for
  `tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts` is
  retired (its stated criterion: the signal-fixture root fix lands and the
  file passes on macos-latest); the file runs again on macOS CI. A new
  durable contract suite pins the group-kill target, the survival
  diagnostic, the ledger retirement, and the `detached: true` spawn that
  makes the group kill safe.
