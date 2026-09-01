# Quarantine flaky dispatch-lanes test (issue #2368)

## What changed

- Appended `tests/unit/tools/dispatch-lanes.test.ts` to
  `scripts/ci/quarantined-tests.txt` (the general/global quarantine ledger)
  with a full evidence-trail comment block.
- Added a regression describe-block (3 tests) to
  `tests/unit/scripts/ci/ci-yml-integration.test.ts` pinning the ledger
  contract: the path is an active general-ledger entry, is NOT duplicated in
  the per-OS windows/macos ledgers, and resolves to a real on-disk file
  discovered by the ci.yml find chain.

## Why

Flake-detection workflow (issue #1782) auto-filed issue #2368 from merge-group
CI run 32984771338 (2026-08-26). Tracing the detection run's downloaded
annotations to the originating job showed the flake occurred in the
`coverage-shard (3)` cell on **ubuntu-latest** (attempt 1 failed,
`Passed on retry 1` at 2026-08-26T15:31:27Z). Coverage shards run ubuntu-only
and honor ONLY the general ledger `scripts/ci/quarantined-tests.txt`
(`scripts/ci/run-coverage-gate.sh` never consults per-OS lists, to keep the
partition aligned with the ubuntu unit cells) — so the general ledger is the
correct target.

The flake class is consistent with the open root-cause issue #2362
(elapsed-timeout tests assert literal `timed out after 10ms`, which is
load/measurement-sensitive under the `--isolate --coverage` environment). The
root fix for #2362 has NOT landed (issue open, no PR), so quarantine is
appropriate rather than suppressing an already-fixed file.

Quarantining also stops duplicate auto-filed issues: sibling issue #2386
(same file, filed 2026-08-27) is covered by this entry, and the detection
script's rule A drops candidates already present in a ledger.

## Migration steps

None for runtime behavior — the `src/` tree is untouched. CI-only data-file
change plus pinning tests. The file passes locally under clean TMPDIR, which
is expected and is the quarantine rationale: the flake is
environment-sensitive (merge-group coverage/isolate context), not a logic bug.

## Known caveats

- Requires CI quarter via merge-group shards to confirm no recurrence; the
  entry retires under the #1782 test-stability sprint / once the #2362 root
  fix lands and demonstrates a green streak.
- Until the #2362 root fix lands, `tests/unit/tools/dispatch-lanes.test.ts`
  is skipped repo-wide (ubuntu unit shards, coverage, macos/windows unit
  shards) while quarantined — a broad scope, but required because the flake
  surfaced in the ubuntu-only coverage job that only honors the general
  ledger.
- Sibling auto-fix branches may hold unmerged quarantine entries targeting
  the same ledger; textual merge conflicts between sibling quarantine PRs are
  the wrapper's concern, not a functional risk.
