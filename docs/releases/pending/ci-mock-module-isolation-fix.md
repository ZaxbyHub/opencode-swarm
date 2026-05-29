## CI: hook test suite mock.module isolation

The `bun test tests/unit/hooks` batch run (168 files, 4371 tests) previously produced 1686 false failures due to `mock.module()` global state leaking across test files. A dedicated per-file isolation step now runs the 15 affected `mock.module` test files as separate `bun test <file>` subprocesses in CI, eliminating cross-contamination failures. The 12 non-mock.module hook test groups continue to run in batch mode. Local per-file execution is unchanged.

- **What**: Added dedicated CI step for mock.module hook tests with per-file process isolation
- **Why**: Fixes Issue #473 — bun:test's `mock.module()` persists globally, causing 1686 batch failures
- **Migration**: None — purely CI infrastructure change
- **Known caveats**: 3 of 15 isolated files have pre-existing logger issues unrelated to mock.module isolation (tracked separately)
