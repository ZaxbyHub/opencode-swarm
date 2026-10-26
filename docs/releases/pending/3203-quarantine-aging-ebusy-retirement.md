# Quarantine aging: retire the #3261 windows EBUSY cohort, renew the two expired entries (#3203)

## What changed

- `tests/unit/hooks/delegation-gate-rework-remediation.test.ts` and
  `tests/unit/hooks/delegation-gate-reentry-bypass.test.ts`: afterEach teardown
  now deletes the per-test temp dir through `safeRmRecursive`
  (`tests/helpers/safe-test-dir.ts`) instead of a raw `await fs.rm` with zero
  retries — the bounded EBUSY/EPERM/ENOTEMPTY retry pattern (~10 s budget,
  `closeProjectDb` first) already proven for the #2190/#2807 windows
  handle-contention class.
- `scripts/ci/quarantined-tests-windows.txt`: the three #3261 windows EBUSY
  entries are retired (6 → 3 active entries; STATUS header updated).
  `tests/unit/session/hydration-populate-guard.test.ts` — its named root fix
  (the same `safeRmRecursive` teardown routing) already landed in-tree via
  #3248 (commit 3bffa0295, pinned by
  `tests/unit/session/hydration-teardown-routing-3248.test.ts`); the two
  delegation-gate files above are root-fixed by this PR. The two entries whose
  named remedies could not be closed from CI evidence
  (`j02-failure-rejection-distinct`, `delegation-gate-background-coder`) are
  renewed to EXPIRY 2026-11-18 under the open #2973 cohort anchor, per the
  renewal-requires-issue policy (#2905).
- `tests/unit/scripts/ci/ci-yml-quarantine-2867.test.ts`: the pinned EXPIRY
  date moves 2026-10-20 → 2026-11-18 with the renewal.

## Why

Issue #3203 (quarantine-aging tracker, workstream #2905): four entries were
expiring within 21 days and two EXPIRYs were already past, putting Check 7 of
`bun run check:invariants` on course to hard-fail CI on 2026-11-01
(j02) and 2026-11-04 (delegation-gate-background-coder). Every entry needed
either a root fix or a policy-compliant renewal before its wall. The EBUSY
cohort's ledger criterion named this exact remedy ("root-fix the EBUSY
teardown (retry-with-backoff or platform-safe cleanup)"); the two renewed
entries had exhausted or already satisfied their named candidates
(delegation-gate-background-coder's `createSafeTestDir` conversion has been in
place since ec5bcceef, 2026-07-24), so renewal with an updated diagnosis under
the open cohort tracker is the honest action.

## Migration steps

None. The quarantine ledgers are CI-internal data files; no runtime or user
facing surface changes. The retirement is validated by this PR's own CI: the
diff touches `scripts/`, so detect-paths runs the full 3-OS unit matrix on the
PR (plus merge-queue), executing the three un-quarantined files on
windows-latest — the #2973 retirement-evidence precedent.

## Known caveats

- The windows EBUSY fix is validated by the PR's windows-latest matrix, not by
  a local windows host (not reproducible on Linux). If a retired file flakes
  again on merge-group windows-latest, re-quarantine narrowly per the ledger's
  re-add rule (fresh merge-group failure, not fixable at the root).
- The two renewed entries keep their quarantine until EXPIRY 2026-11-18; the
  tracker will re-file them as they approach that wall unless root-fixed
  earlier.
