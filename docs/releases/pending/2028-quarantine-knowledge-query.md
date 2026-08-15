# CI: quarantine flaky knowledge-query test on windows-latest

## What changed

- `tests/unit/tools/knowledge-query.test.ts` added to `scripts/ci/quarantined-tests-windows.txt` (windows-latest merge-group shards only).

## Why

Merge-group `unit (windows-latest, 5)` shard: attempt 1 failed ~0.5s immediately after a 6.9s knowledge-add cell, retry passed in 474ms, sibling macOS-5/ubuntu-5 shards green in the same run; the similarly-named `knowledge-query-encounter-score.test.ts` stayed green on windows-4. The test creates mkdtemp temp dirs and chdirs into them per test with afterEach rmSync cleanup — the windows cold-spawn/tmpdir-handle class. Tracked under #1737 / #1782.

## Migration steps

None. Windows unit shards skip the file by design after this change.

## Known caveats

- Quarantine removes the knowledge_query tool's unit coverage from windows CI until #1782 lands the teardown hardening; ubuntu/macos still run it.
