---
issue: 3263
---

# Issue 3263: disposition the merge-group flake cohort (two windows quarantines, five retired as already root-fixed)

## What changed

- Appended two entries with full Check 7 `# OWNER:` / `# EXPIRY:` metadata
  (EXPIRY 2026-12-06) to `scripts/ci/quarantined-tests-windows.txt`:
  - `tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts`
    (CORE-TREE rule-C entry routed after documented review)
  - `tests/unit/commands/archive-dry-run.test.ts`
- Updated the windows ledger `STATUS:` header from 8 to 10 active entries.
- Added no entries to `scripts/ci/quarantined-tests.txt` or
  `scripts/ci/quarantined-tests-macos.txt`.
- Added `tests/unit/scripts/ci/ci-yml-quarantine-3263.test.ts`, pinning
  both windows-ledger entries (active-entry presence, windows-only
  scoping, on-disk existence, Check 7 `OWNER`/`EXPIRY` metadata, and the
  `STATUS:` 8→10 header count) plus the no-entry disposition of the five
  root-fixed files (they must stay out of every ledger).

## Why

Issue #3263's body listed six files flagged across three merge-group runs on
2026-10-14 (runs 38574480126, 38583979646, 38590114992). Per-file evidence
showed two distinct populations:

- Five files — `src/__tests__/cli-version.test.ts`,
  `src/commands/commands.test.ts`, `tests/unit/cli/run-command.test.ts`,
  `tests/unit/hooks/delegation-gate-scope.test.ts`, and
  `tests/unit/hooks/guardrails-modified-files.test.ts` — flaked only in
  ubuntu coverage shards (all `Passed on retry 1`). They are the
  `.swarm/`-missing-on-fresh-shards wave already attributed and root-fixed
  in tree (`scripts/ci/run-coverage-gate.sh:127-144`, fix 3bffa0295 merged
  2026-10-14T19:36Z via PR #3254). All three triggering runs executed on
  merge-queue heads that predated that merge, and none of the five has been
  re-detected in the 3.5 weeks of continuous flake-detection since — so the
  disposition is no quarantine entry (a general-ledger entry would also drop
  them from ubuntu coverage and lose real coverage).
- `tests/unit/hooks/delegation-gate-retry-sounding-board-manual.test.ts`:
  two windows-latest-only passed-on-retry detections three weeks apart
  (run 38590114992 `unit (windows-latest, 3)` on 2026-10-14; run 42106922029
  `unit (windows-latest, 1)` on 2026-11-05), zero ubuntu/macos annotations in
  either run, and the file already uses `createSafeTestDir`/`safeRmRecursive`
  plus a bounded git `spawnSync` — the residual flake is the windows
  git-spawn/completion-observer timing class. Ruled per detector rule C
  following the #2867 delegation-gate-background-coder precedent: windows
  ledger.
- `tests/unit/commands/archive-dry-run.test.ts`: four windows-latest-only
  passed-on-retry detections (runs 39108262782, 40282456510, 42063128798,
  42086378186, shards 2/5/6/6). The 2026-11-05 pair ran on heads that
  verifiably already contain 6f4772b0e (PR #3529, the #3252 fix that
  converted this file's `cleanupDir` to `safeRmRecursive`), which falsifies
  the raw-`rmSync` root-cause theory and fires the ledger-entry branch of
  the rule pre-recorded in the #3263 2026-10-30 triage note ("mark
  not-flaky once #3252 lands, or a ledger entry if it recurs beyond it").

## Migration steps

None for plugin users. CI effect only: `unit (windows-latest, N)` jobs skip
the two quarantined files; ubuntu and macOS unit shards and the ubuntu
coverage gate still execute them (per-OS ledger semantics, ci.yml:746-747).

## Known caveats

- Both quarantines are passed-on-retry flakes: ci.yml discards attempt-1
  output when a retry passes, so no assertion text exists to drive a root
  fix from CI evidence alone.
- The 2026-11-05 archive-dry-run detections fall inside that day's
  merge-group failure cluster; if they were cluster-correlated, the
  three-consecutive-green retirement criterion retires the entry quickly.
- Later detections absorbed by the #3263 tracker after 2026-10-30 (the
  `tests/unit/training/*-2486` family, `tests/unit/evidence/archive.test.ts`,
  the `review-route-*` hooks, and others) still await disposition on the
  tracker; this change settles the original issue body plus the
  archive-dry-run rule the maintainer pre-recorded.
