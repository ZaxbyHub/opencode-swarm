# Quarantine the windows-latest j02 failure-rejection distinctness flake (issue #2826)

## What changed

- Appended one new entry to the Windows-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-windows.txt`:
  - `tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts`
    (windows-latest unit-shard 3 passed-on-retry-2 flake; also detected
    on windows-latest unit-shard 5 passed-on-retry-1 per issue #2810)
- The Windows-ledger `STATUS:` header is bumped from 6 to 7 active
  entries, and the entry list in that header is extended.
- The entry carries the structured `# OWNER:` / `# EXPIRY:` metadata
  block required by `scripts/check-invariants.ts` Check 7 (issue
  #2477), so it hard-fails the gate if the EXPIRY lapses beyond the
  14-day grace window and is not renewed.
- Added a consumer-side regression pinning test
  (`tests/unit/scripts/ci/ci-yml-quarantine-2826.test.ts`, modeled on
  the #2740/#2660/#2761 precedents): it reads the real ledger files and
  asserts the new entry is active in the windows ledger, scoped to that
  ledger only (no cross-ledger duplicate), carries OWNER/EXPIRY
  metadata (Check 7, issue #2477), and that the on-disk path is
  discovered by the ci.yml find chain.
- No source, hook, or workflow code changed. The change is confined to
  the windows ledger file, the regression pinning test, and this
  pending release fragment.

## Why

Issue #2826 was auto-filed by the `flake-detection` workflow (issue
#1782) after a merge-group CI run (`ci.yml` run 35239240597, head
`27d8196445669c53f45acd65c7acd839aeaeb5c5`, started
2026-09-17T15:17:17Z) was processed by flake-detection run 35249385221
at 2026-09-17T16:53:43Z (issue #2826 filed 2026-09-17T17:01:46Z). The
issue body listed:

```
tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts
```

Tracing the detection job back to its upstream CI run (the
`Fetching artifact list for workflow run 35239240597` log line in the
detect job), I downloaded the `flake-suggestions` artifact (id
10508853525) from flake-detection run 35249385221; it carries:

```
::notice file=tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts::Passed on retry 2 (flaky): tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts
```

The origin job is `unit (windows-latest, 3)` (job 105298347794, started
2026-09-17T16:17:29Z); its log records the full attempt trace:

- `2026-09-17T16:24:12.7013367Z ##[warning]Attempt 1 failed, retrying (1/2)`
- `2026-09-17T16:24:51.2636097Z ##[warning]Attempt 2 failed, retrying (2/2)`
- `2026-09-17T16:25:07.0818850Z ##[notice]Passed on retry 2 (flaky)`

Sibling shards in the same CI run were green or round-robin-skipped the
file on this commit; the only other mention of the file in that run was
an incidental `[coverage]` timing line in coverage-shard 5 (green). The
Windows-only sensitivity matches the windows cold-FS / CPU-contention
class already documented for the other windows-ledger entries
(pr-monitor-status, win32-wrapper-runtime, completion-observer-coder,
index-pr-workflow-session-lifecycle-2602).

Independent corroboration: sibling auto-filed issue #2810 (filed
2026-09-16T14:45:33Z, from CI run 35103146629, head 07ae4bb0b) also
listed this file; its `flake-annotations` artifact carries
`Passed on retry 1 (flaky)` for the same path from
`unit (windows-latest, 5)` (job 104825105987: Attempt 1 fail at
2026-09-16T14:06:29Z, Passed on retry 1 at 14:06:44Z). Both independent
detections are windows-latest-only — no ubuntu or macos evidence exists
— so the windows ledger is the correct target rather than the general
or macos ledgers.

The ci.yml retry loop discards attempt-1 output when a retry passes, so
no failing assertion text exists to drive a root-cause fix; the file
passes locally. Per the recipe's local-pass gotcha I ran it under a
clean `TMPDIR`:

```
TMPDIR=$HOME/.cache/hermes-tmp bun test \
  tests/unit/execute-journey/j02-failure-rejection-distinct.test.ts

 4 pass
 0 fail
 17 expect() calls
Ran 4 tests across 1 file. [5.95s]
```

The flake is environment-sensitive (merge-group windows-latest OS matrix
/ contention), not a logic bug — exactly per the quarantine rationale.
The file's four cases each boot a full journey host plus a fresh
isolated temp project and drive configure → discover → specify →
approve → EXECUTE through the registered host surfaces with 120s
budgets, so windows-latest merge-group CPU/filesystem contention is the
likely failure class (see `docs/testing/test-stability.md`).

## Migration steps

No migration required. The change is additive to the CI's existing
quarantine ledgers; it does not modify any code, hook, command, tool,
or runtime contract. Consumers of the published plugin are unaffected;
CI's unit job will continue to skip this file on windows-latest runners
(the `scripts/ci/quarantined-tests*.txt` files have always been filtered
out of unit-job test discovery per `.github/workflows/ci.yml`).

## Known caveats

- The entry is Windows-only and shares the cold-FS / CPU-contention
  class already root-fixed for `tests/unit/commands/pr-monitor-status.test.ts`
  via PR #2190 (`safeRmRecursive` with closed project-db handle +
  bounded EBUSY/EPERM retries in `tests/helpers/safe-test-dir.ts`). The
  expected retirement path is the same: route the test's journey-host
  boot / temp-project teardown through the bounded-retry helpers, or
  trim per-case boot cost so the 120s budgets never contend on
  windows-latest. Both are tracked under the test-stability sprint
  (#1782).
- A sibling auto-fix branch for issue #2810 may also carry a quarantine
  entry for this same file (its candidate list included it). If that PR
  merges to `origin/main` first, the windows-ledger entry here is
  redundant and the wrapper should reconcile the two (the detector has
  no dedupe, so a single-OS entry in the windows ledger is what rule A
  of `detect-and-quarantine-flakes.sh` checks).
- EXPIRY is `2026-10-17`. Check 7 stays silent until that date passes,
  then warns for 14 days and hard-fails on day 15 unless the entry is
  retired by a root fix or renewed with an updated criterion.

Refs: #2826 (this issue), #2810 (sibling detection of the same file),
#1782 (test-stability sprint / flake-detection workflow), #1737 (test
quarantine debt — historical; closed), #2477 (OWNER/EXPIRY metadata
grammar enforced by Check 7), #2666 (the upstream EXECUTE-journey
qualification issue this regression test was added for), #1982
(Windows-only ledger precedent with the same root-fix retirement
pattern via PR #2190), #2185 (Windows-only ledger precedent sharing the
cold-FS / AV-handle class), #2477/#2660/#2740/#2761 (quarantine
pinning-test precedents).
