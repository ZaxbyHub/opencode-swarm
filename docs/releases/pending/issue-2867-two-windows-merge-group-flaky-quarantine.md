# Quarantine two net-new Windows-only flaky tests from issue #2867

## What changed

- Appended two net-new entries to the Windows-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-windows.txt`, each carrying the structured
  `# OWNER:` / `# EXPIRY:` metadata block required by
  `scripts/check-invariants.ts` Check 7 (issue #2477):
  - `tests/unit/commands/close-active-state-unlink-retry.test.ts`
    (windows-latest shard 6 hard failure; `::error ... FAILED` annotation,
    all 3 in-job retries failed)
  - `tests/unit/hooks/delegation-gate-background-coder.test.ts`
    (windows-latest shard 2 passed-on-retry flake; `::notice ... Passed
    on retry 2 (flaky)` annotation — CORE-TREE per detector rule C,
    routed to the windows ledger after human review because the
    annotation is not an infra signature and the sibling OS shards are
    all green)
- Updated the ledger's `# STATUS: N active entries` header from 9 to 11
  (9 pre-existing on main + 2 net-new from this PR).
- Added a new pinning regression file
  (`tests/unit/scripts/ci/ci-yml-quarantine-2867.test.ts`) covering ledger
  presence, scope isolation (windows-only), on-disk path presence for the
  two net-new entries, the windows-ledger `# STATUS` count matching the
  active-entry count, and the Check 7 OWNER / EXPIRY metadata block for
  each entry.
- No source, hook, or workflow code changed. The change is confined to
  the ledger file, the new pinning test file, and this pending release
  fragment.

## Why

Issue #2867 was auto-filed by the flake-detection workflow
(`.github/workflows/flake-detection.yml`,
`scripts/ci/detect-and-quarantine-flakes.sh`) after merge-group CI run
`35491073606` (`merge_group`, head `cffc439a`, 2026-09-20T05:12:12Z,
`run_attempt 1`) produced two flake candidates. Flake-detection run
`35492561496` (filed by the workflow at 2026-09-20T05:47:22Z, exactly
10 s before issue #2867 was created at 2026-09-20T05:47:32Z) opened the
tracking issue with the body listing the candidates verbatim from
`flake-suggestions.txt`:

```
tests/unit/commands/close-active-state-unlink-retry.test.ts
# CORE-TREE (requires human review): tests/unit/hooks/delegation-gate-background-coder.test.ts
```

The detector's two relevant rules (rule A "already quarantined" and
rule C "CORE-TREE withheld for human review") routed the candidates as
follows. Neither candidate was already in any quarantine ledger on
`origin/main`, so rule A did not drop either:

- `close-active-state-unlink-retry.test.ts` → auto-suggested to
  `quarantined-tests*.txt`.
- `delegation-gate-background-coder.test.ts` → marked
  `# CORE-TREE (requires human review)` because it lives under
  `tests/unit/hooks/**`; the issue's triage comment explicitly requires
  a manual review of the merge-group logs before placing it.

Per-OS attribution for the two net-new entries, derived from the
unit-shard annotation artifacts downloaded by flake-detection run
`35492561496` (the detect job's `Fetching artifact list for workflow
run 35491073606` step enumerated all 12 `flake-annotations-*` artifacts
and the per-file annotations came from the per-shard upload in ci.yml):

| File | Unit shard | Outcome | Artifact |
|------|------------|---------|----------|
| `tests/unit/commands/close-active-state-unlink-retry.test.ts` | `unit (windows-latest, 6)` | All 3 in-job retries failed (`::error ... FAILED`) — conclusion `failure` on job 106026202507 | `flake-annotations-unit-shard-6` (id 10599830873) |
| `tests/unit/hooks/delegation-gate-background-coder.test.ts` | `unit (windows-latest, 2)` | Attempt 1 failed, `Passed on retry 2 (flaky)` — conclusion `success` on job 106026202465 | `flake-annotations-unit-shard-2` (id 10599416863) |

Sibling `ubuntu-1..6`, `macos-1..6`, and the other windows-latest shards
ran each file green in the same CI run. The evidence is single-OS
windows-latest for both candidates, so the entries go in the windows
ledger per the windows-ledger re-add policy.

CORE-TREE review (per the issue's triage comment requirement):
the `delegation-gate-background-coder.test.ts` annotation line is
`::notice file=...::Passed on retry 2 (flaky)`. The detector's
`INFRA_SIGNATURES` list (script lines 71-78) covers `was not acquired by
Runner`, `Runner offline`, `job was not acquired`, `The job was
canceled`, `waiting for a runner`, `no space left on device`. None of
those substrings appear in the annotation, so this is a real assertion
flake and not an infra signature. Combined with all-green sibling OS
shards, the placement is the windows ledger (single-OS evidence)
rather than the general ledger (which would falsely imply cross-OS
evidence by suppressing the file on every `RUNNER_OS`).

Both files pass locally on this checkout with a clean `TMPDIR`:

```
$ TMPDIR=~/.cache/hermes-tmp-test bun test tests/unit/commands/close-active-state-unlink-retry.test.ts
5 pass, 0 fail, 15 expect() calls, [1111.00ms]
$ TMPDIR=~/.cache/hermes-tmp-test bun test tests/unit/hooks/delegation-gate-background-coder.test.ts
4 pass, 0 fail, 17 expect() calls, [1.84s]
```

The `delegation-gate-background-coder.test.ts` retry-flake is a
passed-on-retry case; the ci.yml retry loop discards attempt-1 output
when a retry passes, so no failing assertion text exists to drive a
root-cause fix from CI alone. The `close-active-state-unlink-retry.test.ts`
hard failure is the Windows cold-FS / AV-handle class (the same root
cause as `pr-monitor-status.test.ts` per issue #1982,
`win32-wrapper-runtime.test.ts` per issue #2185, `archive.test.ts` per
issue #2812 — fix landed in PR #2190 via `safeRmRecursive` with bounded
EBUSY/EPERM retries); the recommended root-fix pattern is noted in the
entry's `# EXPIRY` criterion line.

Sibling auto-filed issues #2843, #2844, #2845, #2846 also quarantined
`close-active-state-unlink-retry.test.ts` on the same windows ledger
with their own OWNER/EXPIRY metadata; those commits sit on unmerged
sibling auto-fix branches, so textual merge conflicts between sibling
quarantine PRs are expected (per the recipe in
`~/.hermes/skills/auto-fix-issue/references/flaky-test-quarantine.md`),
and the wrapper handles them. The `delegation-gate-background-coder.test.ts`
candidate is fresh for #2867 — no earlier auto-filed issue names it.

## Migration steps

None. Quarantine is a CI-gating data change: the ci.yml unit-shard
discovery pipeline (`grep | sort | comm`) now excludes these two paths
from the gated test set on `windows-latest` only (the windows ledger
applies on `RUNNER_OS == 'Windows'` per the "Collect and partition test
files" step at `ci.yml:629-636`). Ubuntu and macOS continue to run them,
the windows-latest `integration` job is unaffected (it does not honor
any quarantine ledger — only the dedicated `integration` ledger matters
there), and the coverage job honors only the general ledger (no
ubuntu/macos over-suppression).

## Known caveats

- The two net-new quarantined suites pin core behavior: active-state
  SQLite unlink retry semantics and the background coder Stage A
  provenance / parallel-slot-cap path. Both suites are skipped only on
  `windows-latest` merge-group/CI unit shards; ubuntu and macOS continue
  to run them, and each Windows skip has an `EXPIRY` of `2026-10-20`
  with a root-fix criterion. The `EXPIRY` is what forces the retirement
  conversation; `scripts/check-invariants.ts` Check 7 hard-fails the CI
  gate once the `EXPIRY` passes the 14-day grace window.
- Each entry carries `# OWNER: zaxbysauce` and `# EXPIRY: 2026-10-20`
  metadata per the issue #2477 grammar; re-add/edit must preserve both
  lines.
- `scripts/ci/quarantined-tests-windows.txt` now holds 11 active entries
  (9 pre-existing on `origin/main` from issues #1982 / #2185 / #2692 /
  #2761 / #2812, plus the 2 net-new from this PR). The
  `# STATUS: 11 active entries` header line tracks this count; drift
  between the declared count and the actual active-entry count is
  caught by the
  `windows ledger STATUS header count matches its active-entry count`
  test in `tests/unit/scripts/ci/ci-yml-quarantine-2867.test.ts` (and
  by the pre-existing `tests/unit/scripts/ci/ci-yml-windows-quarantine.test.ts`).
- `delegation-gate-background-coder.test.ts` is a CORE-TREE entry per
  detector rule C (`tests/unit/hooks/**` is withheld from
  auto-suggestion by `scripts/ci/detect-and-quarantine-flakes.sh`);
  the entry's `OWNER` line and prose document the human review that
  confirmed the annotation is a real assertion flake (not an infra
  signature) and the placement (windows ledger, not general) follows
  from the single-OS sibling evidence.
- `#1737` / `#1782` / `#2477` (the historic quarantine-debt trackers)
  are CLOSED; the live tracking refs are this issue #2867 (per-flake)
  and #1782 (the test-stability sprint referenced in each entry prose
  for continuity).
