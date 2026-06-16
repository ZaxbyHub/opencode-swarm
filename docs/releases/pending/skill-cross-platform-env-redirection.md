# Cross-platform env var redirection guidance for writing-tests skill

## What changed

Added a new "Platform-specific environment variable redirection" subsection to the `writing-tests` skill's Cross-Platform Test Patterns section. The subsection documents:

- Which platform-specific env vars must be redirected when tests isolate path-resolver-dependent code (`HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` on Linux; `HOME` on macOS; `HOME`, `LOCALAPPDATA`, `APPDATA` on Windows)
- A warning about Bun's `os.homedir()` caching behavior (must set `HOME` before importing modules that call it)
- A per-variable save/restore code pattern matching the canonical `tests/helpers/isolated-test-env.ts` helper
- A recommendation to use `createIsolatedTestEnv()` as the preferred approach

## Why

During PR #1312 review, 3 hive-tier tests failed on Windows because `resolveHiveKnowledgePath()` reads `LOCALAPPDATA` (not redirected by the test's `HOME`/`XDG_DATA_HOME` override). Tests silently read/wrote the real user data file instead of an isolated temp directory. This guidance prevents future occurrences.

## Migration

No code changes required. Test authors should follow the new guidance when writing tests that redirect `HOME` for path-resolver isolation. Existing tests that use `createIsolatedTestEnv()` are already compliant.
