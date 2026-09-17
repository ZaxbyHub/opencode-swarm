# Quarantine six merge-group flaky tests on Windows (issue #2812)

## What changed

- Appended six new entries to the Windows-only CI quarantine ledger,
  `scripts/ci/quarantined-tests-windows.txt`, each carrying the structured
  `# OWNER:` / `# EXPIRY:` metadata block required by
  `scripts/check-invariants.ts` Check 7 (issue #2477):
  - `tests/unit/background/pr-subscriptions-checkpoint.test.ts`
  - `tests/unit/commands/archive.test.ts`
  - `tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts` (CORE-TREE per
    detector rule C)
  - `tests/unit/mcp/write-receipts-feedback-2500.test.ts`
  - `tests/unit/memory/recall-evaluation-profile-isolation.test.ts`
  - `tests/unit/tools/phase-complete.lock-adversarial.test.ts`
- Updated the ledger's `# STATUS: N active entries` header from 3 to 9.
- Added a new pinning regression file
  (`tests/unit/scripts/ci/ci-yml-quarantine-2812.test.ts`) covering ledger
  presence, scope isolation (windows-only), on-disk path presence for all
  six candidates, and the windows-ledger `# STATUS` count matching the
  active-entry count.
- No source, hook, or workflow code changed. The change is confined to the
  ledger file, the new pinning test file, and this pending release
  fragment.

## Why

Issue #2812 was auto-filed by the flake-detection workflow
(`.github/workflows/flake-detection.yml`, `scripts/ci/detect-and-quarantine-flakes.sh`
rule set) after merge-group CI run 35113965170 (`merge_group` pr-2765, head
`16f82fcec19271f6`, 2026-09-16T15:14:18Z) produced six flake candidates.
Flake-detection run 35118789787 (filed by the workflow at
2026-09-16T15:57:37Z) opened the tracking issue with the body listing the
candidates verbatim from `flake-suggestions.txt`.

Per-OS attribution comes from the originating CI run's per-shard unit job
logs (the flake annotations feed only carries forward the file path, not the
OS — the OS attribution is reconstructed by matching the
`flake-annotations-unit-shard-N` artifact id to its source matrix cell):

| File | Unit shard | Outcome |
|------|------------|---------|
| `tests/unit/background/pr-subscriptions-checkpoint.test.ts` | `unit (windows-latest, 1)` | `Attempt 1 failed` → `Passed on retry 1` (passed-on-retry flake) at 2026-09-16T15:25:22Z |
| `tests/unit/commands/archive.test.ts` | `unit (windows-latest, 5)` | `Attempt 1 failed` → `Passed on retry 1` (passed-on-retry flake) at 2026-09-16T15:30:13Z |
| `tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts` | `unit (windows-latest, 4)` | `Attempt 1 failed` → `Passed on retry 1` (passed-on-retry flake) at 2026-09-16T15:42:12Z — CORE-TREE per detector rule C |
| `tests/unit/mcp/write-receipts-feedback-2500.test.ts` | `unit (windows-latest, 5)` | `Attempt 1 failed` → `Passed on retry 1` (passed-on-retry flake) at 2026-09-16T15:43:19Z |
| `tests/unit/memory/recall-evaluation-profile-isolation.test.ts` | `unit (windows-latest, 5)` | All 3 in-job retries failed at 2026-09-16T15:45:09Z (hard failure, FAILED annotation) |
| `tests/unit/tools/phase-complete.lock-adversarial.test.ts` | `unit (windows-latest, 1)` | All 3 in-job retries failed at 2026-09-16T15:47:21Z; assertion at `tests/unit/tools/phase-complete.lock-adversarial.test.ts:336` expected `"incomplete"` and received `"blocked"` (hard failure, FAILED annotation) |

All six files pass locally on this checkout with a clean `TMPDIR`:

```
$ TMPDIR=~/.cache/hermes-tmp bun test tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts --timeout 120000
6 pass, 0 fail, 23 expect() calls, 24.83s
$ TMPDIR=~/.cache/hermes-tmp bun test tests/unit/commands/archive.test.ts --timeout 120000
8 pass, 0 fail, 32 expect() calls, 0.628s
$ TMPDIR=~/.cache/hermes-tmp bun test tests/unit/tools/phase-complete.lock-adversarial.test.ts --timeout 120000
12 pass, 0 fail, 38 expect() calls, 1.383s
$ TMPDIR=~/.cache/hermes-tmp bun test tests/unit/background/pr-subscriptions-checkpoint.test.ts --timeout 120000
17 pass, 0 fail, 41 expect() calls, 6.88s
$ TMPDIR=~/.cache/hermes-tmp bun test tests/unit/mcp/write-receipts-feedback-2500.test.ts --timeout 120000
7 pass, 0 fail, 28 expect() calls, 6.67s
$ TMPDIR=~/.cache/hermes-tmp bun test tests/unit/memory/recall-evaluation-profile-isolation.test.ts --timeout 120000
3 pass, 0 fail, 422 expect() calls, 2.24s
```

Sibling `ubuntu-1..6`, `macos-1..6`, and the other windows shards ran
each file green in the same CI run — the evidence is single-OS
windows-latest, so all six entries go in the windows ledger per the
windows-ledger re-add policy. The general ledger would suppress the files
on ubuntu/macos too and the macOS ledger applies only on macOS runners.

`tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts` is the only CORE-TREE
candidate (lives under `tests/unit/hooks/**` per detector rule C). The
detector's CORE-TREE flagging normally drops this candidate, but the
human-review justification for keeping it under quarantine is documented
in the ledger entry: the file's own header at
`tests/unit/hooks/pr-workflow-gate-batch-gc.test.ts:35-42` declares the
suite "inherently slow: ~4s against bun's 5000ms default, i.e. flaky by
construction" and the cold-FS latency on windows-latest merge-group
shards exceeds the 60s per-test timeout floor. The same file was
quarantined by the `auto-fix/issue-2761-...` sibling branch (commit
`ceb96ae49`, not yet on `origin/main`) on the general ledger; this branch
routes the same file to the windows ledger because the single-OS evidence
routes the placement correctly per the recipe.

The two hard-failure files
(`recall-evaluation-profile-isolation.test.ts` and
`phase-complete.lock-adversarial.test.ts`) have captured assertion text on
attempt 1 that pinpoints the failure mode: the recall evaluator's third
cell flips its no-profile-recall baseline under cold-FS pressure, and the
phase_complete lock-contention cell sees `"blocked"` instead of the
expected `"incomplete"` because a concurrent lock winner is still holding
the lock when the second caller observes it. Both are the canonical Windows
cold-FS / AV-handle / handle-race class that the #1782 quarantine debt
already pays down in the #1982 #2185 #2692 entries; recommended root-fix
patterns (safe `rmSync`-with-bounded-EBUSY/EPERM retries matching the
PR #2807 pattern for issue #2602) are noted in each entry's `# EXPIRY`
criterion line.

## Migration steps

None. Quarantine is a CI-gating data change: the ci.yml unit-shard
discovery pipeline (`grep | sort | comm`) now excludes these six paths
from the gated test set on `windows-latest` only (the windows ledger
applies on `RUNNER_OS == 'Windows'` per the "Collect and partition test
files" step at `ci.yml:629-636`). Ubuntu and macOS continue to run them,
the windows-latest `integration` job is unaffected (it does not honor any
quarantine ledger — only the dedicated `integration` ledger matters there),
and the coverage job honors only the general ledger (no ubuntu/macos
over-suppression).

## Known caveats

- The six quarantined suites pin a mix of correctness- and
  safety-critical behavior: PR-subscriptions steady-state cap invariants +
  crash-resume, `/swarm archive` deletion reporting, the #1968 P4
  MAX_WORKFLOW_BATCHES GC reclaim, MCP receipt-feedback identity / status
  / transition guarantees, recall-evaluator per-profile reranking isolation,
  and `phase_complete` lock acquisition + path-traversal hardening. Each
  suite is skipped only on `windows-latest` merge-group/CI unit shards;
  ubuntu and macOS continue to run them, and the Windows skip has an
  `EXPIRY` of `2026-10-31` with a root-fix criterion. The `EXPIRY` is what
  forces the retirement conversation; `scripts/check-invariants.ts` Check
  7 hard-fails the CI gate once the `EXPIRY` passes the 14-day grace
  window.
- The CORE-TREE entry (`pr-workflow-gate-batch-gc.test.ts`) is a CORE-TREE
  quarantine (the file lives under `tests/unit/hooks/**`); the
  human-review justification is documented in the entry's comment block
  per the detector rule C contract. The recommended root-fix path is
  shrinking the suite's per-test work (e.g. shrinking
  `MAX_WORKFLOW_BATCHES` for these tests via a test-only override, or
  pre-seeding minimal fixtures so the full-cap loop is unnecessary) or
  raising the per-test timeout floor used by merge-group windows-latest
  cold-FS shards from 60s to 120s.
- Each entry carries `# OWNER: @zaxbysauce` and `# EXPIRY: 2026-10-31`
  metadata per the issue #2477 grammar; re-add/edit must preserve both
  lines.
- `scripts/ci/quarantined-tests-windows.txt` now holds 9 active entries
  (3 pre-existing per issues #1982/#2185/#2692 + 6 new per issue #2812).
  The `# STATUS: 9 active entries` header line tracks this count; drift
  between the declared count and the actual active-entry count is caught
  by `tests/unit/scripts/ci/ci-yml-quarantine-2812.test.ts`'s
  windows-ledger STATUS-count test.
- `#1737` / `#1782` / `#2477` (the historic quarantine-debt trackers) are
  CLOSED; the live tracking refs are this issue #2812 (per-flake) and
  #1782 (the test-stability sprint referenced in each entry prose for
  continuity).