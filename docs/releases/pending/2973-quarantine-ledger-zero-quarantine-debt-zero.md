---
issue: 2973
title: Quarantine debt reaches zero — last four ledger entries retired
---

## What changed

- All four quarantine ledgers now hold **0 active entries** (windows 3 → 0,
  macos 1 → 0; general and integration already 0). The Check 7 census prints
  `total active: 0` / `first hard-fail date: none` and the next-wall warning
  is gone — the 2027-01-04 hard-fail wall is eliminated. Retired per
  issues #2973 + #3218 with per-entry retirement bases recorded in the
  ledger headers.
- `tests/unit/hooks/pr-feedback-scope-controller.test.ts` (macos entry,
  #2973): the 2026-09-12 passed-on-retry flake's attempt-1 evidence was
  recovered from the run's repository-validation artifact — the race test
  expected exactly one fulfilled Task call and received zero. The race test
  is now determinism-hardened: a bounded attempt-counted re-race (≤3) that
  retries ONLY the two environmental shapes (shared pre-consumption
  transient; winner-consumed-then-post-consume failure) with a disjoint
  outcome classifier, fails immediately on any atomicity violation (two
  fulfilled, two typed losers, foreign consumption), and pins the
  designed-loser rejection reason — a discrimination the old assertion
  lacked.
- New spec `tests/unit/hooks/pr-feedback-scope-race-transient-2973.test.ts`
  pins the production semantics behind the flake: an injected pre-consume
  transient makes BOTH racing calls fail closed **non-destructively** (the
  declaration stays unconsumed), and the clean re-race reserves exactly once
  with the typed loser on the other call.
- `tests/unit/tools/dispatch-lanes-pr-review-resilience-followups.test.ts`
  (windows entry, #2973): the raw `await fs.rm` teardown (zero EBUSY/EPERM
  retry budget over a live WAL SQLite DB + git-init tree — the exact class
  sibling retirements cured) is converted to the repo's guarded
  `safeRmRecursive` with the sibling's 30s hook budget. The un-stubbed
  real-git preflight latency is a disclosed watch item: a re-flake
  re-quarantines with fresh merge-group evidence per the #1782 convention,
  and the per-attempt validation-report artifact carries attempt-1 stderr.
- Four quarantine pin suites converted to retired-absence shapes
  (ci-yml-quarantine-2730/3248-windows/3263/3264) with orphaned metadata
  helpers removed; the windows ledger keeps a `# STATUS: 0 active entries`
  header (the five relative-count suites pin declared == actual, whatever
  it is).
- The archive pair (#3218) needed no new code: PR #3672's determinism
  hardening already landed; the entries' own skip behavior was the only
  thing blocking the "2 consecutive green windows-latest merge-group runs"
  criterion, which now accumulates from this PR's own queue run onward.

## Why

The four remaining entries could not retire while active — the ledger skip
prevented the very home-platform executions their criteria required. Two of
them (#3251's probe race and the archive pair) were already root-fixed in
#3672; the macos race-test flake turned out to be a test over-specification
(the atomicity guarantee holds under the transient), and the windows
dispatch-lanes teardown carried a known-class deterministic hazard.
