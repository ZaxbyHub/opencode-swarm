# CI: quarantine flaky council-quorum-adversarial test on windows-latest

## What changed

- `tests/adversarial/council-quorum-adversarial.test.ts` added to `scripts/ci/quarantined-tests-windows.txt` (windows-latest merge-group shards only).

## Why

Merge-group run 30824435784, `unit (windows-latest, 3)` shard: attempt 1 failed ~0.8s, immediate retry passed in 638ms, sibling ubuntu-3 and macOS-3 shards green in the same run (246ms/335ms). The test `mkdtemp`s a temp dir and `rmSync`s it in a finally block on Windows using raw `rmSync`, not the #2112-hardened `safeRmRecursive` helper — consistent with the windows tmpdir-handle sensitivity class. Passed-on-retry is the only evidence; CI discards attempt-1 output. Tracked under #1737 / #1782.

## Migration steps

None. Windows unit shards skip the file by design after this change.

## Known caveats

- Quarantine removes this adversarial suite from windows CI until the root cause (teardown hardening) is fixed under #1782; ubuntu/macos still run it.
