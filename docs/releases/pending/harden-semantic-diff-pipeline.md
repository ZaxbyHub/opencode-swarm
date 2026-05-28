---
feat(diff): harden semantic diff pipeline with symlink containment, typed git errors, async I/O, class rename
---

- **Security**: `buildSemanticDiffBlock` now validates both repo root and file targets via `realpathSync`. Files resolving outside repo root (including symlink escapes) are silently skipped.
- **Error-model cleanup**: Replaced ad-hoc `_gitBinaryMissing` marker mutation with typed `GitBinaryMissingError` class and `isGitBinaryMissing()` type guard, used in both `semantic-diff-injection.ts` and `diff-summary.ts`.
- **Performance**: Converted per-file synchronous I/O to async (`execFile` callback + `fs.promises.readFile`) in affected paths. `diff-summary` now exits immediately on missing git binary.
- **Design**: `extractSignature()` produces class body signatures, enabling class rename detection in `ast-diff.ts`.
- **Backward compatibility**: `DiffResult.astSkippedCount` restored as `@deprecated` field for downstream consumers.
- **Subprocess safety**: `stdio: ['ignore', 'pipe', 'pipe']` added to all `execGit` async wrappers for defense-in-depth on Windows/Bun.
- **Test fix**: Cross-platform path handling in symlink escape tests — use `path.resolve()` for mock keys, passing on Windows and Unix.
- **Housekeeping**: Removed stray `test-tmp-discovery-profiles/pyproject.toml` test artifact.

### Caveats
- Test files use `vi.mock()` for Node built-ins which can produce cross-file failures when tests are co-run in the same Bun process. Tests pass correctly when run individually. This is a pre-existing codebase-wide pattern.

### Migration
No migration required.
