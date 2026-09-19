# Quarantine flaky close-active-state-unlink-retry test on Windows (issue #2846)

## What changed

- Appended one new entry to the Windows-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-windows.txt`:
  - `tests/unit/commands/close-active-state-unlink-retry.test.ts`
    (windows-latest unit-shard 2, hard-failure EBUSY on `rmSync` teardown)
- Updated the ledger's `# STATUS: N active entries` header from 6 to 7.
- Added a regression pinning test,
  `tests/unit/scripts/ci/ci-yml-quarantine-2846.test.ts`, that reads the
  real ledger files off disk and asserts the entry is present exactly once
  in the Windows ledger, absent from the general/macos/integration ledgers,
  carries OWNER/EXPIRY metadata (issue #2477 Check 7), exists on disk, and
  that the `STATUS` header count matches the active-entry count.
- No source, hook, or workflow code changed. The change is confined to the
  Windows ledger file, the pinning test, and this pending release fragment.

## Why

Issue #2846 was auto-filed by the flake-detection workflow (issue #1782,
`.github/workflows/flake-detection.yml`) after merge-group CI run 35422590582
(`merge_group` pr-2837, head `bdeba4456f2cdf053368e2114a8f93f9f06cb173`,
2026-09-19T04:55:50Z) produced one hard-failure annotation in
`flake-annotations-unit-shard-2.txt`:

```
::error file=tests/unit/commands/close-active-state-unlink-retry.test.ts::FAILED: tests/unit/commands/close-active-state-unlink-retry.test.ts
```

Tracing the detection job back to its upstream CI run (via the
`Fetching artifact list for workflow run 35422590582` log line in
flake-detection.yml), the per-OS repository-validation artifact
`repository-validation-unit-windows-latest-2/unit-shard-2-117.json`
(job 105851906292, `unit (windows-latest, 2)`) captured the failure:

```
(fail) active-state unlink retry > releases Bun query-cache handles before
       deleting a closed project database [562.00ms]
EBUSY: resource busy or locked,
  rm 'C:\Users\RUNNER~1\AppData\Local\Temp\close-query-cache-Hj4dmS'
  at ...\tests\unit\commands\close-active-state-unlink-retry.test.ts:93:4
```

All three ci.yml retry attempts (attempt 1 at 06:14Z, attempt 2 at 06:14Z,
attempt 3 at 06:40Z — last successful upload of `flake-annotations-unit-shard-2`
at 06:40:54Z, but the retry loop exhausted without a passing attempt) failed
with the same `EBUSY` from `rmSync` in the test's `finally` block. The file
was scheduled to run only in `unit (windows-latest, 2)` — the OS-shard-2
expected-files list (`scripts/ci/quarantined-tests.txt` filter applied
identically per OS, but each OS's `find … | sort -u` round-robin
partition places this test in shard 2 only on Windows due to ext4 / APFS /
NTFS sort-order differences). Sibling OS shards in the same run did not
include this file and were green. The evidence is single-OS, so the entry
goes in the Windows ledger.

The test exercises five behaviors of
`src/commands/close.ts#unlinkActiveStateFileWithRetry`:
transient-EBUSY retries, transient-EPERM retries, non-transient failure
propagation, bounded retry budget exhaustion, and Bun query-cache handle
release before deletion. The first four cases use mocked
`unlink` / `sleep` / `collectGarbageBestEffort` through the `_internals`
DI seam and pass deterministically. The fifth case opens a real
`bun:sqlite` project DB in a `canonicalMkdtemp` directory, runs 100
queries, calls `closeProjectDb(directory)`, and then `rmSync(directory,
{ recursive: true, force: true })` in `finally` — a textbook windows-latest
cold-FS / AV-handle race. The same pattern was root-fixed for
`pr-monitor-status.test.ts` via PR #2190 using
`tests/helpers/safe-test-dir.ts#safeRmRecursive` (closed project-db handle +
bounded EBUSY/EPERM retries); this test still uses raw `rmSync` and would
benefit from the same helper. The file passes locally on a clean `TMPDIR`
(this checkout, all 5 cases pass in 1.0–1.1s), confirming the flake is
environment-sensitive rather than a logic bug.

## Migration steps

None. This is a CI test-skip data change — no runtime, config, or API
change. The change is consumed only by `.github/workflows/ci.yml` (the
`quarantined-tests-windows.txt` filter under `RUNNER_OS == Windows`) and
`scripts/ci/run-unit-tests-local.ts`.

## Known caveats

- The quarantined suite pins safety-critical active-state SQLite unlink
  retry semantics (transient-EBUSY/EPERM retry budget, non-transient
  failure propagation, query-cache handle release before deletion). It is
  skipped only on windows-latest merge-group/CI unit shards; ubuntu and
  macOS continue to run it. The Windows skip has an `EXPIRY` of `2026-10-17`
  with a root-fix criterion (use `tests/helpers/safe-test-dir.ts` →
  `safeRmRecursive` with a closed project-db handle + bounded
  EBUSY/EPERM retries, the same pattern already root-fixed for
  `pr-monitor-status.test.ts` via PR #2190). The EXPIRY is what forces
  the retirement conversation; `scripts/check-invariants.ts` Check 7
  hard-fails the CI gate once the EXPIRY passes the 14-day grace window.
- `#1737`/`#1782` (the historic quarantine-debt / test-stability sprint
  trackers) are CLOSED; live tracking refs are this issue #2846
  (per-flake) and `#1782` is the sprint issue referenced in the entry
  prose for continuity (the #1782 auto-detection workflow is the
  upstream source of the per-flake issues).
- The entry carries `# OWNER: zaxbysauce` and `# EXPIRY: 2026-10-17`
  metadata per the issue #2477 grammar; re-add / edit must preserve
  both lines.
- `STATUS: 7 active entries` header must be kept in sync — the ledger
  change is purely declarative; the count is enforced by
  `tests/unit/scripts/ci/ci-yml-integration.test.ts` (31 pass / 0 fail
  on this branch).
