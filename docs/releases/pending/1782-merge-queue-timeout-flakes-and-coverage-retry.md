# `test(stability)`: de-flake merge-queue timeout races and give the coverage gate retry parity

## Summary

- **De-flaked three wall-clock races** that repeatedly evicted PRs from the merge queue. Each raced a real timer against real work and could invert on a fast or loaded runner:
  - `tests/unit/background/workspace-snapshot-digest-failure-reasons.test.ts` — two cases set `_internals.revisionEnumerationTimeoutMs = 1` and asserted that enumerating a tiny temp git fixture *exceeded* 1ms. On a fast runner enumeration finished first, the digest succeeded, and the assertions failed. This one failed CI on 6+ PRs; on PR #2080 it failed all three attempts, exhausted the retry budget, and was evicted from the queue.
  - `tests/unit/turbo/lean/runner.timeout-adversarial.test.ts` — raced a 5ms lane-dispatch timeout against a mock rejecting at 20ms (4x margin), then waited a fixed `Bun.sleep(100)` for cleanup.
  - `tests/unit/review/dispatcher.test.ts` — waited a fixed `Bun.sleep(40)` for a real 15ms timeout to propagate (2.67x margin).
- **The fix removes the race rather than widening it.** Each competing branch is now structurally unable to win: stubs never settle on their own, so the production deadline is the sole resolver; observations await the real signal (an `'abort'` event, a bounded poll on the observable condition) instead of guessing a window. Deadlines were not simply raised — that narrows a race without removing it.
- **Gave `scripts/ci/run-coverage-gate.sh` the same bounded retry** the unit and integration jobs already had (`max_retries=2`, three attempts). The coverage job is merge-queue-only, so a single transient flake there evicted a PR with no chance to self-heal, and a requeue costs a full ~30-60 min re-run. The `coverage/` directory is reset before **every** attempt, preserving the per-file lcov isolation invariant from issue #1712.
- **Wired the new flake annotations end-to-end**, not just emitted them: the script writes `flake-annotations-coverage.txt`, the `coverage` job uploads it, and `flake-detection.yml`'s artifact pattern was broadened from `flake-annotations-unit-shard-*` to `flake-annotations-*` so the advisory quarantine-suggestion pipeline actually consumes it.
- **Made one timing guard self-policing.** The async enumeration test's per-test budget is now a named constant plus an assertion that the budget still sits below the deadline a mis-wired call would take, so lowering `GIT_SNAPSHOT_TIMEOUT_MS` fails loudly instead of silently rendering the guard inert.
- **Split `runner.timeout-adversarial.test.ts` under FR-006.** The de-flake grew an already-over-cap file (1032 -> 1097 lines), which trips the cap ratchet. Its `ATTACK VECTOR T6` block moved to `tests/unit/turbo/lean/runner.timeout-adversarial-lane-state.test.ts`; the original now shrinks to 896.
- **Added 8 structural tests** in `tests/unit/scripts/ci/ci-yml-integration.test.ts` covering the retry loop, the in-loop coverage reset, both annotation appends, the upload step, and the broadened detection pattern — so the new CI behavior is not untested.

## User-facing changes

None. No runtime or `src/` behavior changed — this touches tests, CI scripts, workflow YAML, and docs only.

## Migration notes

None required.

## Known caveats

- `flake-detection.yml` only runs when the triggering `ci` run concluded in `failure`, so a flake that self-heals on retry is logged in its job's step output but is not auto-surfaced as a quarantine suggestion. This is a property of the trigger and applies to the unit shards' annotations exactly as much as the coverage job's; it is now documented in `docs/testing/test-stability.md` rather than left implicit.
- The bounded-poll helpers in the new lane-state test are bounded by **poll count**, not milliseconds. This is deliberate: Windows quantizes timer waits to its ~15.6ms scheduler tick, so a sub-tick nominal interval costs the same there while costing far less on Linux, and a millisecond-denominated bound overshoots ~3x on Windows and pushes its own error path past the per-test budget.

## Discovery context

The digest-timeout flake was traced from a merge-queue eviction of PR #2080. The remaining races were found by sweeping for the same shape — a real timer raced against real work with a small margin — rather than fixing only the reported instance. Related: #1705 (quarantine ledger), #1712 (per-file coverage isolation), #1782 (test-stability sprint), #1968 (the timeout-vs-git-failed distinction the digest tests guard).
