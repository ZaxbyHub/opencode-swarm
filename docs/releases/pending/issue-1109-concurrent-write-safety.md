`appendTestRun` and `batchAppendTestRuns` in `history-store` now use a filesystem-based mutex lock to serialize concurrent writes, preventing lost updates when multiple callers write test-history in parallel.

The lock uses `mkdir`-based acquisition with 5s timeout and 60s stale-lock recovery. Both mutation paths share the same lock discipline. A concurrent regression test validates parallel child-process writers produce no data loss.

The concurrent test was also fixed to properly bypass the project-root validation guard in child processes, ensuring it runs correctly in CI.

No migration required.
