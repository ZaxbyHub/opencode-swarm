## Summary

- Fix `/swarm close` git alignment so a missing git executable is reported
  separately from a non-git directory, and transient git errors are reported
  separately from both.
- Preserve the existing reset behavior when the workspace is a real git repo.
- Update the adjacent close test suite to use canonical plan fixtures and a
  ledger-backed terminal-state helper.

## Why

The close command was conflating git lookup failures ("git binary not found",
"spawnSync timeout") with "not a git repository," which hid the real failure
mode and forced manual archiving/reset handling.

The adjacent test suite had drifted from the current plan schema and ledger
identity rules, so it could no longer prove the terminal-write path accurately.

## Migration

No migration required. The `isGitRepo()` function is retained as a thin wrapper
over the new `getGitRepositoryStatus()` so that callers outside the close path
are unaffected.

## Caveats

- `scripts/repro-704.mjs` times out in both the branch worktree and a clean
  `origin/main` worktree in this environment; it is tracked as a pre-existing
  validation issue and is not part of this change.
