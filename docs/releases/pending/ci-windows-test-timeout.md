# CI: Per-file wall-clock timeout wrapper for Windows merge-queue shards

## What changed

A process-level timeout wrapper was added around CI test-file execution. Each test file now runs under a 180-second wall-clock budget; if the budget is exceeded, the wrapper kills the test process and reports the file as failed.

- **Timeout detection:** When a file exceeds its budget, CI output includes a `[TIMEOUT]` log line identifying the file by name, making hung shards easy to triage.
- **Per-file timing:** Every test file now emits a `[TIMING]` JSON Lines entry with its wall-clock duration, on all platforms. This gives consistent per-file timing data regardless of OS.
- **Scope:** The wrapper applies to all CI test shards; it is especially critical on Windows merge-queue shards, where the underlying issue was most acute.

## Why

This addresses Issue #1403, where individual test files could block Windows merge-queue shards indefinitely. The root cause is Bun issue #32056: on Windows, per-test `--timeout` does not fire when a hung test leaves the event loop idle. The previous CI configuration (PR #1395, two-tier sharding) reduced overall shard time but still had no defense against a single hung file stalling an entire shard.

The process-level wrapper is independent of Bun's test-runner timeout and works by monitoring wall-clock time from the outside, so it is not affected by event-loop idle conditions.

## Migration steps

None. The change is internal to the CI test runner configuration; no local workflow or command changes are required.

## Known caveats

- A timed-out file is reported as failed rather than skipped; the test result reflects the timeout rather than a pass/fail verdict from the test framework.
- The 180-second budget is a CI-only ceiling; local `bun test --timeout` behavior is unchanged.
- `[TIMING]` output is additive. If downstream tooling parses CI logs, it should tolerate or ignore the new JSON Lines entries.
