# `fix(security)`: correct drive-letter asymmetry in validateSymlinkBoundary on Windows

## Summary

- `validateSymlinkBoundary` (`src/utils/path-security.ts`) could throw a spurious "Symlink resolution escaped boundary" error on Windows whenever exactly one of its two inputs (`targetPath`, `rootPath`) happened to exist on disk while the other did not.
- Root cause: when `fs.realpathSync` throws for a nonexistent path, the function fell back to `path.normalize`, which does **not** attach a drive letter to a rootless POSIX-style absolute path (e.g. `/foo/bar`) on Windows. Meanwhile, `fs.realpathSync` on the side that *does* exist returns a fully resolved, drive-letter-qualified path. Comparing a drive-lettered path against a non-drive-lettered one via `startsWith` is an apples-to-oranges comparison that fails regardless of whether a real boundary violation occurred.
- Fix: the fallback now uses `path.resolve` instead of `path.normalize`. `path.resolve` anchors a rootless-absolute path to the current process drive — the same anchoring `realpathSync` implicitly performs for a path that exists — so both fallback branches produce a consistent comparison basis whether or not either side happens to exist.

## User-facing changes

None directly — this is an internal path-security utility. The practical effect: `validateSymlinkBoundary`'s one real caller (`getGraphPath` in `src/tools/repo-graph/storage.ts`, guarding `.swarm/repo-graph.json` against symlink escapes) no longer risks a false-positive boundary-violation error caused by incidental filesystem state unrelated to the actual paths being validated.

## Migration notes

None required.

## Discovery context

Found while investigating why PR #1800 was removed from the GitHub merge queue for a `unit (windows-latest)` failure. The repo's CI intentionally runs Windows/macOS shards only on `merge_group` (not on regular `pull_request` checks, for fast feedback — see `.github/workflows/ci.yml:114-125`), so this pre-existing bug was never caught by ordinary PR validation.

The failure was traced to `tests/unit/utils/path-security.test.ts`'s `validateSymlinkBoundary > handles non-existent paths gracefully`, which failed because an unrelated test elsewhere in the repo (`src/state.rehydration-adversarial.test.ts`, which uses a hardcoded literal path `/non/existent/dir/67890` instead of an `os.tmpdir()`-scoped path — itself an AGENTS.md invariant-7 violation, out of scope for this fix) leaves a real directory behind at that exact location, creating the asymmetric-existence condition that exposed the bug. The bug was reproduced deterministically, independent of that incidental pollution, via a new regression test that explicitly forces one side to exist and the other not to (Windows-only, since the drive-letter concept doesn't exist elsewhere).
