# Quarantine 2026-10 merge-group flake cohort (issue #3264)

## What changed

Seven merge-group flake detections from the issue #3264 cohort (plus its
comment batches, 2026-10-14 through 2026-10-20) are quarantined with full
OWNER/EXPIRY metadata (issue #2477 grammar, `check:invariants` Check 7),
after per-run evidence attribution from all eleven triggering CI runs:

- `scripts/ci/quarantined-tests-windows.txt` (+5; STATUS 3 → 8 active after
  the #3411 retirement of the 3-entry #3261 EBUSY cohort landed mid-PR —
  the branch was cut when the ledger held 6):
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
  stays honest (declared == actual, 8 at the shipped head), and same-basename sibling
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
- NOT quarantined, watch list: the remaining storm-window candidates
  whose only evidence falls inside the 2026-10-14/18 windows teardown
  storms and which have been green in every run since (the 2026-10-14
  coverage-shard trio — `src/__tests__/cli-version.test.ts`,
  `src/commands/commands.test.ts`, `tests/unit/cli/run-command.test.ts` —
  was named in all four cohort issue bodies, a same-day four-detection
  cohort with zero recurrences in the 11 harvested runs through
  2026-10-20, and the coverage CORE-TREE pair), plus
  `pr-subscriptions-checkpoint.test.ts` (its storm-window retry satisfies
  the #2973 re-add rule's floor but is plausibly storm-correlated — left
  for human adjudication).
- One correction to that triage thread, whose attribution this fragment
  otherwise follows: its aside that the issue-body candidates "don't
  exist in the current tree — they only appear in docs/archive" is wrong
  — all six body candidates are tracked on `origin/main` with long
  history. They stay off the ledgers on evidence, not existence: zero
  post-2026-10-14 recurrences across the cohort threads and no
  attributable triggering run (the issue bodies, unlike the comment
  batches, carry no run URL), so no honest OWNER/EXPIRY evidence block
  could be written for them.
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
- At the branch point, `delegation-gate-background-coder` (expired
  2026-10-20) and `j02-failure-rejection-distinct` (expired 2026-10-17)
  sat inside the Check 7 grace window; the #3203 renewal (merged mid-PR
  as #3411) has since renewed both to EXPIRY 2026-11-18, so this change
  ships with no grace-window warnings for them.
