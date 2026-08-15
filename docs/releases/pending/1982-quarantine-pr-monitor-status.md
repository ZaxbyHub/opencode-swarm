# CI: quarantine flaky pr-monitor-status test on windows-latest

## What changed

- `tests/unit/commands/pr-monitor-status.test.ts` added to `scripts/ci/quarantined-tests-windows.txt` (windows-latest merge-group shards only; ubuntu/macos keep running it).

## Why

Flaky on windows-latest merge-group shards only, passing on retry all three times it was auto-detected (runs 29658529531, 30576075961, 31615996444) with all sibling OS/shards green. Root cause per the quarantine entry: fixtures build from the live clock (`lastCheckedAt = Date.now() - 90_000`) and assert exact relative-time strings, so a ~30s runner stall flips the rendered bucket; per-test `mkdtempSync`/`rmSync` teardown can race AV-held handles on Windows (the #1782 EBUSY class). CI's retry loop discards attempt-1 output when a retry passes, so no assertion text exists to drive a root-cause fix. Tracked under #1737 / #1782.

## Migration steps

None. The file is skipped on windows-latest unit shards by design after this change.

## Known caveats

- Quarantine removes the file from windows CI coverage until the test-stability sprint (#1782) lands a root-cause fix (fake-clock fixtures); the entry will be retired then.
