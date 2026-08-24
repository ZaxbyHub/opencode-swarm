# Fix deterministic first-run flake in prod-store-tripwire test (issue #2233)

## What changed

`tests/helpers/prod-store-tripwire.test.ts` (the issue #2033 production-store
tripwire safety-guard suite) no longer leaves the real `links/` store root
behind when its "link-store writes throw" probe materializes it. The test now
records whether `<dataDir>/links` existed before the probe (via the unguarded
`existsSync`) and removes it again after the probe (via the unguarded
`rmdirSync`) when the probe created it, restoring the store's top-level
listing to its process-start state.

## Why

The merge-group flake-detection workflow (issue #1782) flagged the file in CI
run 32190439859 (issue #2233) and again behind issue #2235. The mechanism was
deterministic, not environmental:

1. The probe test calls `mkdirSync(<dataDir>/links/regression-probe,
   { recursive: true })` — `mkdirSync` is intentionally unguarded by the
   tripwire, so on a fresh CI runner (no `~/.local/share/opencode-swarm` etc.)
   this creates the real `links/` store root.
2. The guarded `writeFileSync` throws as designed, and the old cleanup
   `rmdirSync` removed only the `regression-probe` leaf — the newly
   materialized `links/` root stayed behind.
3. The preload's global `afterAll` bookend (`verifyRealStoresUnchanged`,
   registered by `tests/preload/prod-store-tripwire.ts`) then saw the data
   dir's top-level listing drift from `[]` to `['links']` and failed the whole
   file — with all 8 tests passing.
4. The CI retry ran on the same runner: attempt 2 captured `links/` in its
   start-of-process fingerprint, before/after matched, and the file passed.

Hence attempt-1-fail / pass-on-retry-1 on **all three OSes in the same run**
(`unit (ubuntu-latest, 2)` 22:00:51Z, `unit (windows-latest, 2)` 22:02:14Z,
`unit (macos-latest, 2)` 22:05:48Z on 2026-08-18 — the file lands in shard 2
of the round-robin split on every platform). The suite landed on main via
PR #2200 at 2026-08-18T06:18Z; every merge-group run since flaked it on
attempt 1, including silently-retried green runs (e.g. runs 32184127546 and
32193064942 carry the same retry annotations but concluded success — the
detection workflow only files an issue when the run overall fails). Reproduced
locally with a fresh `HOME`: first run fails with `data-dir top-level listing
changed` and leaves `~/.local/share/opencode-swarm/links` behind; the
immediate re-run passes. The fix removes the drift; three consecutive
fresh-`HOME` runs now pass with no residue.

The triage note in issue #2233 considered whether the detector was catching
the suite's *intentional* guard trips; it was not — the CI retry wrapper keys
on the whole-file exit code, and the intentional guard throws are
`expect`-ed (the file exits 0 when behaving as designed). This was a real
self-inflicted failure of the suite's own store-unchanged bookend.

## Migration steps

None. No source code, quarantine ledger, or workflow changed — the fix is
confined to the test file's cleanup logic.

## Known caveats

- The proper-fix alternative considered and rejected: quarantining the file in
  `scripts/ci/quarantined-tests.txt` per the issue's default instruction. That
  would have suppressed a healthy #2033 safety suite for a 6-line cleanup bug,
  so the ledger is intentionally left empty.
- If a future probe in this suite materializes other real-store entries (the
  tracked set is `links` and `quarantine-backups` in
  `tests/helpers/prod-store-tripwire.ts`), the same pre/post-existence restore
  pattern must be applied there too — the afterAll bookend will catch any
  miss, which is exactly how this bug surfaced.
- Issues #2233 and #2235 describe the same deterministic flake and should be
  closed by this fix rather than by quarantine entries.
