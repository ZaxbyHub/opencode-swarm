# test(tools): stabilize the merge-group collect host-timeout flake (issue #2572)

- `tests/unit/tools/dispatch-lanes-collect-host-timeout.test.ts` no longer flakes under merge-group CI
  (coverage-shard attempt-1 failure + retry-pass, run 33926973723; the earlier PR #2587 windows-latest
  incident was the same defect). Root cause: the file drove `collect_lane_results`' wall-clock budget
  math against the real clock, so any runner stall >= `timeout_ms` between the deadline assignment and
  the first per-lane budget reservation zeroed every slice and flipped salvage outcomes to pending —
  a faulty test expectation, not a host-timeout regression (production degrades non-destructively by
  design, #2381/#2392).
- The shared fixture now pins the collection clock by default (`_internals.now` -> fixed epoch), making
  budget reservation deterministic and stall-invariant; the fixture's `withTestDeadline` hang guard
  widens 500 ms -> 2500 ms with documented arithmetic (measured ~150 ms idle cost, PR #2587-class
  multi-hundred-ms runner stalls, 12 x 2.5 s worst case inside the 60 s per-file coverage budget).
  The three sibling suites whose `wait: true` scenarios genuinely need real deadline progression
  (collect-revision-snapshot, collect-diagnostic-lifecycle, pr-review/replay-corpus-observer) opt out
  via `{ deterministicClock: false }` and are unchanged.
- New regression test: the salvage scenario stays complete when a true 120 ms event-loop stall
  (`Atomics.wait`, no raw clock usage) lands in the exact root-cause window; reverting the fixture's
  clock install turns it red.
- No quarantine entry: the file is fixed at the root, satisfying the issue's 2026-09-05 closure
  contract (no allowlist-as-closure, no OWNER/EXPIRY debt).
