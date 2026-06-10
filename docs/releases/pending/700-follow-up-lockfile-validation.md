# Lock file path validation hardening

## What changed

Enhanced defense-in-depth validation for lock file deletion safety:

- Added grandparent directory check to `isSafeLockFilePath()` to reject misconfigured nested paths like `opencode/opencode/filename`
- Improved the `SWARM_PLAN` path-removal warning in `src/commands/close.ts:843-847` to show the full candidate path instead of just the basename, enabling better debugging of path-related issues
- Clarified documentation explaining why `isSafeLockFilePath()` and `isSafeCachePath()` are kept separate (different validation rules)

## Why

PR #700 review revealed that lock file path validation needed additional hardening. The grandparent check provides an extra layer of defense against misconfigured nested directory structures that could arise from automation or manual errors.

## Migration

No migration required. These changes only affect internal safety validation and error messages.

## Breaking changes

None. These are backward-compatible safety improvements.

## Known caveats

None.
