# `test`: test-stability sprint — freezeClock helper, detection, runbook

## Summary

- Added a deterministic-clock test helper `tests/helpers/test-clock.ts`
  (`freezeClock`, `withFrozenClock`, `withFrozenClockAsync`) so time-sensitive
  assertions stop flaking under coverage instrumentation. bun's `bun:test` does
  not export `FakeTime`, so the helper builds on the repo's proven `spyOn(Date)`
  pattern.
- Added `tests/helpers/test-isolation.ts` (`withIsolatedState`,
  `setupIsolatedState`) composing the existing env + temp-dir + clock helpers
  into one call.
- Added a diff-scoped lint `scripts/check-test-clock.sh` (wired into the
  `quality` CI job) that fails only on NEW test files touching the real clock
  without referencing the helper — pre-existing files are non-blocking.
- Added advisory flake detection: `.github/workflows/flake-detection.yml`
  (`workflow_run` on failed merge-group ci runs) downloads the new
  per-shard `flake-annotations-*` artifacts that ci.yml's unit job now uploads,
  runs `scripts/ci/detect-and-quarantine-flakes.sh`, and best-effort opens a
  tracking issue + uploads a `flake-suggestions` artifact.
- Added `docs/testing/test-stability.md` — a contributor runbook for the four
  root-cause classes (time-sensitive, coverage-sensitivity, cross-platform,
  subprocess) and the helpers/conventions/detection that prevent them.
- Migrated the 3 ad-hoc `spyOn(Date, ...)` sites (skill-scoring-e2e ×2,
  manager-plan-md-sync ×1) and fixed the quarantined skill-scoring-workflow
  test (wrapped in `withFrozenClock`; the file stays quarantined until a
  merge-group run confirms greenness on all 3 OSes).
- Added `docs/audits/test-stability-audit.md` — the flake inventory with
  per-test root-cause classification and acceptance-criteria status.

## User-facing changes

None — test/CI infrastructure only. No runtime behavior changed.

## Migration notes

New time-sensitive tests must use `withFrozenClock` (or reference it) or the
`check-test-clock.sh` lint will fail the `quality` job. See
`docs/testing/test-stability.md`. The lint is diff-scoped: pre-existing test
files that touch `Date.now()` / `new Date()` are non-blocking warnings and can
be migrated opportunistically.

## Why

The merge-group CI matrix (Windows × 4 + macOS × 4 + coverage + integration)
repeatedly kicked PRs out of the queue on pre-existing flakes invisible to the
PR-branch Ubuntu-only CI (issue #1782). This ships the systemic layer
(deterministic-time helper + detection + lint + runbook) so the class of flakes
stops recurring and new ones are caught before they block a PR.

## Honest limitations

- 5-consecutive-green-merge-group-requeues and a two-week soak cannot be proven
  in one PR — they require elapsed wall-clock and multiple real PRs through the
  queue. Tracked in `docs/audits/test-stability-audit.md` as "requires ongoing
  CI observation."
- Auto-quarantine is advisory: it produces a suggestion artifact + best-effort
  tracking issue. Auto-appending to `quarantined-tests.txt` (needs a PAT +
  branch-protection bypass) is intentionally out of scope.

Refs #1782 (partial delivery of the test-stability sprint — does not close it;
AC2/AC8 require ongoing CI observation and AC3/AC4/AC6 have follow-up work).
