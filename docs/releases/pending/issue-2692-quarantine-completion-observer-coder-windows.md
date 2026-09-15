# Quarantine flaky completion-observer-coder test on Windows (issue #2692)

## What changed

- Appended one new entry to the Windows-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-windows.txt`:
  - `tests/unit/background/completion-observer-coder.test.ts`
    (windows-latest unit-shard 1, passed-on-retry flake)
- Updated the ledger's `# STATUS: N active entries` header from 2 to 3.
- Added a 4-test pinning regression file
  (`tests/unit/scripts/ci/ci-yml-quarantine-2692.test.ts`) covering ledger
  placement, scope isolation (windows-only), on-disk path presence, and the
  OWNER/EXPIRY metadata grammar required by `scripts/check-invariants.ts`
  Check 7 (issue #2477).
- No source, hook, or workflow code changed. The change is confined to the
  ledger file, the new pinning test file, and this pending release fragment.

## Why

Issue #2692 was auto-filed by the flake-detection workflow (issue #1782,
`.github/workflows/flake-detection.yml`) after merge-group CI run 34410703321
(`merge_group` pr-2644, head `740b66aa4`, 2026-09-09T22:08:51Z) produced one
flake annotation:

```
::notice file=tests/unit/background/completion-observer-coder.test.ts::Passed on retry 1 (flaky): tests/unit/background/completion-observer-coder.test.ts
```

Tracing the detection job back to its upstream CI run (via the
`Fetching artifact list for workflow run N` log line in
flake-detection.yml), the annotation artifact
`flake-annotations-unit-shard-1` was uploaded by `unit (windows-latest, 1)`
and its job log shows `Attempt 1 failed, retrying (1/2)` → `Passed on retry 1`
(windows-only passed-on-retry flake). Sibling shards in the same run ran the
same file green: `unit (ubuntu-latest, 1)` (1.182s) and `unit (macos-latest,
1)` (2.414s). The evidence is single-OS, so the entry goes in the Windows
ledger — the general ledger would suppress the file on ubuntu/macos too and
the macOS ledger applies only on macOS runners.

The test file is integration-heavy: every case builds a real git repository
via `spawnSync('git', ...)` with a 5s timeout
(`tests/unit/background/completion-observer-coder.test.ts:26-39`) and drives
async completion-observer events, so slow windows-latest runners or
filesystem contention can push the git spawns/past-HEAD checks over the line.
The ci.yml retry loop discards attempt-1 output when a retry passes, so no
assertion text exists to drive a root-cause fix. The file passes locally
(this checkout), confirming the flake is environment-sensitive rather than a
logic bug.

## Migration steps

None. This is a CI test-skip data change — no runtime, config, or API change.

## Known caveats

- The quarantined suite pins safety-critical coder settlement behavior
  (HEAD-drift staleness fencing, terminal-claim idempotency, ingestion
  fencing). It is skipped only on windows-latest merge-group/CI unit shards;
  ubuntu and macOS continue to run it, and the Windows skip has an EXPIRY of
  2026-10-31 with a root-fix criterion. The EXPIRY is what forces the
  retirement conversation; `scripts/check-invariants.ts` Check 7 hard-fails
  the CI gate once the EXPIRY passes the 14-day grace window.
- `#1737`/`#1782`/`#2477` (the historic quarantine-debt trackers) are CLOSED;
  live tracking refs are this issue #2692 (per-flake) and #1782 is the sprint
  issue referenced in the entry prose for continuity.
- The entry carries `# OWNER: zaxbysauce` and `# EXPIRY: 2026-10-31` metadata
  per the issue #2477 grammar; re-add/edit must preserve both lines.
