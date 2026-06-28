# `test(repo-graph)`: cross-platform hardening test suite

## Summary

- Added **`tests/unit/tools/repo-graph/cross-platform.test.ts`** — 33 unit tests covering all cross-platform primitives in `src/tools/repo-graph/` (issue KG-02/18)
- Tests cover: path normalization (`normalizeGraphPath`), ENOENT/non-ENOENT error handling (`safeRealpathSync`), CRLF-safe line number consistency in ontology extraction, grammar directory resolution from all three build layouts (`resolveGrammarsDir`), workspace-relative query output (`getDependencies`/`getImporters`), workspace containment enforcement via `_internals` DI mock, and symlink/junction cycle termination in `buildWorkspaceGraphAsync`

## User-facing changes

None — test-only change. No production code changed.

## Migration notes

None required.

## Discovery context

Identified during KG-02/18 issue ingest: all cross-platform primitives in `src/tools/repo-graph/` were correct by inspection but had no unit test coverage. The new suite verifies them explicitly and will catch regressions in the 3-OS CI matrix (Ubuntu / macOS / Windows).

Known gap documented in the test file: case-insensitive filesystem collisions (`Foo.ts` vs `foo.ts` on Windows/macOS) are deferred to a future KG iteration (KG-02/18 scope; case-insensitive collisions out of scope).
