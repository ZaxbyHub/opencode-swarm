# Quarantine-ledger retirement ahead of the Check 7 walls + flake root fixes

## What

Clears the 2026-11-28..2026-12-05 quarantine-census hard-fail wall cohort
(#2973, #3630) and fixes the verified flake root causes behind three entries
(#3251, #3218 determinism, #3262's 2026-11-12 detection):

- **12 ledger entries un-quarantined** (post-#3640 stability cohort): the
  16-file local battery is green 48/48, the entries had zero home-platform CI
  executions while quarantined — the 3 general-ledger entries were skipped on
  every OS (the general ledger is consulted everywhere as a skip list) and the
  9 per-OS-ledger entries were skipped on their home platform only (the same
  entries still ran in Linux unit/coverage jobs, which consult only the
  general ledger) — and their retirement criteria accumulate green
  merge-group runs now that they execute again on their home platform.
  Tracked per-entry in the PR body — no completed-retirement claim is made
  until each criterion's runs are green.
- **4 entries re-anchored** with new testable criteria (EXPIRY 2026-12-20,
  no bare date rolls): `archive.test.ts` + `archive-dry-run.test.ts` to #3218
  (determinism-hardened; original CI mechanism unproven),
  `dispatch-lanes-pr-review-resilience-followups` and
  `pr-feedback-scope-controller` to #2973 (diagnosis pending).
- **#3251 root fix**: `nativeOutputLimitProbe` extracted into
  `tests/helpers/native-output-limit-probe-3251.ts` with honest
  `terminationObserved`/`terminationObservedLate`/`attempts` reporting, bounded
  re-observation (≤3 attempts), and a 1s kill-origin deadline inside a 10s
  spawn backstop — a green receipt now proves the overflow controller (not the
  spawn timeout) terminated the child. The macOS ledger entry retires with the
  root fix in the same PR (#3251 AC2).
- **#3218 determinism hardening**: `makeBundleOld` (archive + archive-dry-run)
  invalidates the process-global artifact cache after its same-size rewrite
  (the #1729 defect class); the fresh-bundle test pins `updated_at` to the
  frozen clock (removes the real-clock coupling); a new
  `archive-retention-boundary-3218.test.ts` spec pins the strict-`<` cutoff
  boundary (fresh/new-side/old-side/exact-boundary), 25-iteration determinism,
  and the cache-flip leg.
- **#3262 detection root fix**: the lock-stale telemetry flush poll is
  ENOENT-guarded (shared reader, ENOENT-only — other errors propagate), fixing
  the first-poll ENOENT class from coverage-shard run 43115686414.
- Quarantine pin suites converted to the retired-absence / re-anchored shapes;
  the windows STATUS header tracks the 3 re-anchored entries.

## Why

Check 7 warned `first hard-fail wall 2026-11-28 in 16 days` with 14 of 16
entries walling by 2026-12-05 — every PR's CI would have gone red. The
retirement follows the ledger's own criteria (root-fix-first triage; un-quarantine
experiments with tracked closure conditions; re-anchors only where a diagnosis
leg is still missing).

## Scope

Test-infra + CI-policy only; zero runtime `src/` production changes.
