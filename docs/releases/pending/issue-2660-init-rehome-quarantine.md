# CI Quarantine: init-rehome retry-flake on ubuntu-latest coverage context (#2660)

## What changed

Quarantines `tests/unit/telemetry/init-rehome.test.ts` in
`scripts/ci/quarantined-tests.txt` (the general ledger) so the merge-group
coverage gate stops retrying it indefinitely during ubuntu-latest coverage
shards. The test still runs on every other platform/shard; only the
ubuntu-latest coverage-shard invocation is skipped until a root fix lands.

The entry carries the `# OWNER:` / `# EXPIRY:` metadata required by
`scripts/check-invariants.ts` Check 7 (issue #2477). EXPIRY is
`2026-10-15` — 30 days out, well inside the 14-day grace window so the
gate warns rather than fails. A regression pinning test
(`tests/unit/scripts/ci/ci-yml-quarantine-2660.test.ts`, modeled on the
#2730 analogue) reads the real ledgers and asserts the entry is active
in the general ledger, absent from the per-OS/integration ledgers,
carries OWNER/EXPIRY, and that the on-disk path is discovered by the
ci.yml find chain. No other ledger, test, or source file changed.

## Why

Issue #2660 was filed automatically by `scripts/ci/detect-and-quarantine-flakes.sh`
when flake-detection run `34311972198` (2026-09-09T04:41:50Z) ingested the
annotations from CI run `34309871068` (merge_group,
head `701e628206badece23c92fefd941a778973b2c84`) and observed:

```
::notice file=tests/unit/telemetry/init-rehome.test.ts::Passed on retry 1 (flaky)
```

A retry-passed-on-retry flake: attempt 1 failed, attempt 2 passed. The
ci.yml retry loop discards attempt-1 output when a retry passes, so no
assertion text exists to drive a root-cause fix. The flake is confined to
ubuntu-latest coverage-shard 1 of the same CI run — sibling
coverage-shards 2/3/4/5/6 were green on this file in the same run, and
all six ubuntu/macos/windows unit shards were green or did not run the
file. The test passes locally in ~149ms (5/5 cases) on this checkout.

The telemetry re-home path itself (init A then init B produces two
`telemetry.jsonl` files; same-directory re-init is a no-op; fail-open
ownership retention on failed new-stream creation; canonical same-root
check) is correct per PR #2472 W9 and the follow-up fix
`71bad1b5e fix(runtime): close PR #2588 review findings`. The flake is
test-harness sensitivity under coverage context — the file's
`waitFor`/`waitForContent` pollers use a 2-second deadline against
`createWriteStream`-driven async appends, and a slow append can blow the
budget on attempt 1.

`scripts/ci/run-coverage-gate.sh` runs ubuntu-only and honors ONLY the
general ledger (`scripts/ci/quarantined-tests.txt`) — its header at
`scripts/ci/run-coverage-gate.sh:98` says coverage is ubuntu-only and
must never branch on `RUNNER_OS`. This makes the general ledger the only correct target;
adding the path to `quarantined-tests-macos.txt` or `-windows.txt` would
have no effect on coverage and would confuse triage.

## Migration steps

No user migration required. This is a CI hygiene change only; no runtime,
plugin manifest, public API, configuration schema, or user-visible
behavior changes.

## Known caveats

- **Quarantine debt**: tracked under #1782 (test-stability sprint) and
  #1737 (quarantine debt), the latter closed by #1729/#1908 and cited
  here as a label for the debt class.
- **Sibling issue #2730 (still OPEN)**: #2730 also names
  `tests/unit/telemetry/init-rehome.test.ts` (its own detection run,
  2026-09-12, coverage-shard 3 on ubuntu-latest) and its unmerged
  auto-fix branch (commit `4199ba657`) adds a parallel general-ledger
  entry for the same file. Both PRs will collide textually on
  `scripts/ci/quarantined-tests.txt`; whichever merges second must
  re-verify the entry's OWNER/EXPIRY block and preserve a single entry
  (the flake-detection script Rule A drops already-quarantined
  candidates, so duplicates are noise for detection). The
  `ci-yml-quarantine-2660.test.ts` pinning test reads the real ledger
  files, so the post-merge state (ledger content, metadata block, the
  on-disk path) gets re-verified by the unit suite on every CI run.
- **EXPIRY**: `2026-10-15`. Past that date the entry fails `check:invariants`
  Check 7 unless retired by a root fix or renewed with an updated criterion.
- **Same-basename trap**: no `tests/{root}/init-rehome.test.ts` exists
  alongside `tests/unit/telemetry/init-rehome.test.ts` — only the one
  path is quarantined; the consumer-side parse replication
  (`grep|sort|comm` over the ci.yml ~298-310 chain) shows the path
  correctly absent from the gated-test set.
- **Issue #2657 cross-check**: #2657 names
  `tests/unit/pr-review/replay-corpus-transcript.test.ts`, a different
  file; no merge conflict.