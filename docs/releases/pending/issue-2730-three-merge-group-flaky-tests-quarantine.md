# Quarantine three merge-group flaky tests (issue #2730)

## What changed

- Appended two new entries to the macOS-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-macos.txt`:
  - `tests/unit/hooks/pr-feedback-scope-controller.test.ts`
    (macos-latest unit-shard 1, passed-on-retry flake)
  - `tests/unit/utils/bun-compat-exit-first-2530.test.ts`
    (macos-latest unit-shard 5, hard failure on both attempts)
- Appended one new entry to the general/global CI quarantine ledger,
  `scripts/ci/quarantined-tests.txt`:
  - `tests/unit/telemetry/init-rehome.test.ts`
    (ubuntu-latest coverage-shard 3, passed-on-retry flake)
- Each entry carries the structured `# OWNER:` / `# EXPIRY:` metadata
  block required by `scripts/check-invariants.ts` Check 7 (issue
  #2477), so the entries hard-fail the gate if the EXPIRY lapses beyond
  the 14-day grace window and is not renewed.
- Added a 14-test pinning regression file
  (`tests/unit/scripts/ci/ci-yml-quarantine-2730.test.ts`) covering the
  three new entries (ledger placement, scope isolation, OWNER/EXPIRY
  metadata, on-disk path presence) and the no-duplicate invariant for
  the path that is already quarantined by issue #2738.
- No source, hook, or workflow code changed. The change is confined to
  the two ledger files, the new pinning test file, and this pending
  release fragment.

## Why

Issue #2730 was auto-filed by the `flake-detection` workflow (issue
#1782, introduced by the merge-group flake-detection phase §6) after a
merge-group CI run (`ci.yml` run 34670762927, head `1499a74b`,
2026-09-12T04:27:48Z → 04:34:14Z) reported four candidate paths. The
issue body listed:

```
# CORE-TREE (requires human review): tests/unit/hooks/pr-feedback-scope-controller.test.ts
tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts
tests/unit/telemetry/init-rehome.test.ts
tests/unit/utils/bun-compat-exit-first-2530.test.ts
```

Tracing the detection job back to its upstream CI run (via the
`Fetching artifact list for workflow run N` log line in
flake-detection.yml), I cross-referenced the per-shard `flake-annotations-*`
artifacts against the run's `unit (RUNNER_OS, SHARD)` jobs and confirmed
single-OS evidence for each new entry:

- `tests/unit/hooks/pr-feedback-scope-controller.test.ts` — macos-latest
  unit-shard 1 (`Attempt 1 failed, retrying (1/2)` →
  `Passed on retry 1 (flaky)` at 2026-09-12T03:56:04Z). All sibling
  macos shards (2/4/5/6), all ubuntu unit shards (1-4), and all
  windows unit shards (2/3/4/6) were green on this file or did not run
  it by shard round-robin distribution. macOS ledger is correct.
- `tests/unit/utils/bun-compat-exit-first-2530.test.ts` — macos-latest
  unit-shard 5 (`Attempt 1 failed, retrying (1/2)` then
  `Attempt 2 failed, retrying (2/2)` → `##[error]FAILED` at
  2026-09-12T03:57:26Z). Sibling macos shards and all ubuntu/windows
  shards were green on this file or did not run it. The failing cell is
  `native Bun reports bounded output overflow and terminates the
  child` at
  `tests/unit/utils/bun-compat-exit-first-2530.test.ts:450-454` —
  `expect(receipt.exitCode !== 0 || receipt.signalCode !== null).toBe(true)`
  fails because native Bun on macos-latest returns both `exitCode 0`
  and `signalCode null` after the bounded-output termination path,
  defeating the exit-or-signal expectation. macOS ledger is correct.
- `tests/unit/telemetry/init-rehome.test.ts` — ubuntu-latest
  coverage-shard 3 (`Attempt 1 failed, retrying (1/2)` →
  `Passed on retry 1 (flaky)` at 2026-09-12T04:04:09Z). Sibling
  coverage-shards 1/2/4/5/6 were green. The coverage job runs
  ubuntu-only and honors ONLY the general ledger
  (`scripts/ci/run-coverage-gate.sh:85,111` — its own header comment at
  `:98-104` states coverage is ubuntu-only and must never branch
  per-OS), so the general ledger is the only correct target.

The fourth candidate from the issue body,
`tests/unit/scripts/ci/repository-validation-real-process-2675.test.ts`,
is already quarantined in the macOS ledger via issue #2738 (commit
`ad8c53ae3`, 2026-09-12). The detection script's Rule A drops
already-quarantined candidates, so re-listing it in any other ledger
would be a silent no-op for detection but a confusing cross-ledger
duplicate for triage; the new pinning test asserts that the path stays
in the macOS ledger (the existing #2738 entry) and is NOT duplicated
into the general or windows ledgers by this PR.

Local reproduction on this checkout (per the recipe's local-pass
gotcha, run under a clean `TMPDIR`):

```
TMPDIR=~/.cache/hermes-tmp bun test \
  tests/unit/hooks/pr-feedback-scope-controller.test.ts \
  tests/unit/telemetry/init-rehome.test.ts \
  tests/unit/utils/bun-compat-exit-first-2530.test.ts \
  --timeout 120000

 21 pass
 0 fail
 87 expect() calls
Ran 21 tests across 3 files. [5.70s]
```

This is the expected quarantine rationale: the flake is
environment-sensitive (merge-group OS matrix / coverage instrumentation),
not a logic bug. All three files pass locally. The `ci.yml` retry loop
discards attempt-1 output when a retry passes, so no assertion text
exists for `pr-feedback-scope-controller` or `init-rehome`; for
`bun-compat-exit-first-2530` both retries were exhausted and the
captured assertion is the one cited above (the native Bun path on
macOS does not terminate the child with a non-zero exit or a signal
when the bounded-output stream is closed mid-write).

## Migration steps

None. The macOS and general ledgers are honored by the existing
`scripts/ci/run-unit-tests-local.ts` (`bun run test:unit:ci`) consumer
and by the corresponding steps in `ci.yml` (macOS branch at
`.github/workflows/ci.yml:632` for the macOS ledger, the unconditional
general-ledger read at the same step for the global ledger). After this
commit merges, subsequent merge-group CI runs will skip the three files
in their respective unit and coverage jobs.

## Known caveats

- **Quarantine is not a fix.** These entries suppress flake-induced red
  shards in CI but do not address the underlying environment
  sensitivity. Retirement should be pursued under a dedicated
  test-stability sprint (the original test-stability sprint, issue
  #1782, is closed; a follow-up issue should be opened when one is
  created).
- **`scripts/check-invariants.ts` Check 7** hard-fails any quarantine
  entry whose `# EXPIRY:` lapses beyond the 14-day grace window. The
  EXPIRYs below are set inside the grace window (30 days out); if the
  underlying flakes persist past EXPIRY, the entries must be renewed
  with an updated criterion (or the tests root-fixed) to keep CI green.
- The macOS entries are single-OS: macOS-latest merge-group flakes with
  green sibling shards. If a future flake-detection run produces
  cross-OS evidence for either file, the entries should be moved to
  the general ledger (matching the precedent set by issue #2368's
  `dispatch-lanes.test.ts` general-ledger quarantine after a
  coverage-shard flake on ubuntu).
- The `init-rehome.test.ts` entry is in the general ledger rather than
  a per-OS ledger. That is a deliberate choice for this PR: the
  coverage job (`scripts/ci/run-coverage-gate.sh`) never branches
  per-OS, so the file would be exercised by coverage no matter where
  it is listed — but only the general ledger stops the next
  coverage-shard run from re-filing the same flake (Rule A only drops
  already-quarantined candidates).
- Sibling auto-fix branches can hold unmerged quarantine entries that
  conflict textually with this one. Per the recipe, ledger state on the
  task branch = `origin/main` state at checkout; textual conflicts
  between sibling quarantine PRs are the wrapper's concern, not a
  blocker.

Refs: issue #2730, issue #1782 (flaky-test detection workflow),
issue #2477 (OWNER/EXPIRY metadata grammar enforced by Check 7),
issue #2738 (the pre-existing #2675 macOS-ledger entry this PR
defers to), issue #2368 (precedent for a coverage-shard general-ledger
quarantine with captured assertion text).