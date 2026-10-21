# Quarantine 2026-10 merge-group flake cohort (issue #3264)

## What changed

Seven merge-group flake detections from the issue #3264 cohort (plus its
comment batches, 2026-10-14 through 2026-10-20) are quarantined with full
OWNER/EXPIRY metadata (issue #2477 grammar, `check:invariants` Check 7),
after per-run evidence attribution from all eleven triggering CI runs:

- `scripts/ci/quarantined-tests-windows.txt` (+5, STATUS 6 → 11 active):
  `tests/unit/tools/test-runner-feedback-regressions.test.ts` (passed-on-
  retry on windows-latest three times in five days, the last after the
  2026-10-18 worktree-storm fixes), `tests/unit/full-auto/state-locking.test.ts`
  (hard failure 3/3 attempts: cross-process RMW worker exited 1 at
  `state-locking.test.ts:290`),
  `tests/unit/evaluation/runner-failures.test.ts` and
  `tests/unit/workflow/coder-settlement-2214-hardening.test.ts` (both
  post-storm-fix recurrences, 2026-10-19/20), and
  `tests/unit/commands/archive.test.ts` (re-add per the #2973 retirement
  re-add rule — fresh merge-group windows-latest failure).
- `scripts/ci/quarantined-tests-macos.txt` (+1):
  `tests/unit/plan/manager-current-phase-2532.test.ts` (passed-on-retry on
  macos-latest twice six days apart, the second post-storm-fix).
- `scripts/ci/quarantined-tests.txt` (+1):
  `tests/unit/background/plan-sync-worker.test.ts` (passed-on-retry on
  ubuntu-latest, 2026-10-20; ubuntu evidence routes to the general ledger
  because the coverage gate honors only that ledger — issue #2660
  precedent).
- `tests/unit/scripts/ci/ci-yml-quarantine-3264.test.ts` (new): companion
  ledger-pinning regression test (the #2761/#2826/#2867 pattern) asserting
  each of the seven entries is active in exactly its attributed ledger,
  carries the OWNER/EXPIRY block, exists on disk, the windows STATUS header
  stays honest (11), and same-basename sibling
  `tests/unit/evidence/archive.test.ts` stays in the gated set.

## Why

The flake-detection workflow filed the cohort, but the issue's own triage
comment asked that candidates be cross-checked against the triggering
merge-group runs rather than appended blindly. Every candidate was
attributed to its exact run/shard/OS via the check-run annotations API,
distinguished hard failures from passed-on-retry flakes, and checked
against post-detection root fixes:

- NOT quarantined, root-fixed on main: `guardrails-worktree-authority` and
  `guardrails-worktree-containment-hardening` (windows hard failures
  through 2026-10-18T15:06Z; the fixes `473df7e07` + `592e7b233` landed
  2026-10-18 and all three later merge-group runs execute both files
  green), and `tests/unit/hooks/w3368-diag-temp.test.ts` (deliberate
  fail-on-purpose diagnostic, deleted by `473df7e07`).
- NOT quarantined, watch list: the remaining single-detection candidates
  whose only evidence falls inside the 2026-10-14/18 windows teardown
  storms and which have been green in every run since (including the
  2026-10-14 coverage-shard trio and the coverage CORE-TREE pair), plus
  `pr-subscriptions-checkpoint.test.ts` (its storm-window retry satisfies
  the #2973 re-add rule's floor but is plausibly storm-correlated — left
  for human adjudication).
- No CORE-TREE file (`tests/unit/{scope,agents,hooks}/**`) was mechanically
  quarantined, per detector rule C and the issue's triage comment.

## Migration steps

None — quarantine ledgers are CI metadata; no runtime, config, or user-
facing surface changes. CI's unit/coverage jobs will skip the seven files
on their attributed OS (general ledger: all OS) from the next run.

## Known caveats

- `tests/unit/commands/archive.test.ts` is quarantined while its
  same-basename sibling `tests/unit/evidence/archive.test.ts` is NOT —
  verified the sibling stays in the gated set.
- Retry-flake entries carry no assertion text (ci.yml discards attempt-1
  output when a retry passes); their evidence is the annotation trail
  cited in each ledger block.
- All seven entries expire 2026-11-20 with three-consecutive-green
  retirement criteria; Check 7 warns from that date and hard-fails 14 days
  later.
- Pre-existing grace-window warnings for `delegation-gate-background-coder`
  (expired 2026-10-20) and `j02-failure-rejection-distinct` (expired
  2026-10-17) are untouched by this change.
