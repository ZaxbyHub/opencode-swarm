## Summary
- Fix `/swarm close` git alignment so a missing git executable is reported separately from a non-git directory.
- Preserve the existing reset behavior when the workspace is a real git repo.
- Update the adjacent close test suite to use canonical plan fixtures and a ledger-backed terminal-state helper.

## Why
- The close command was conflating git lookup failures with "not a git repository," which hid the real failure mode and forced manual archiving/reset handling.
- The adjacent test suite had drifted from the current plan schema and ledger identity rules, so it could no longer prove the terminal-write path accurately.

## Migration
- No migration required.

## Caveats
- `scripts/repro-704.mjs` times out in both the branch worktree and a clean `origin/main` worktree in this environment, so it is tracked as a pre-existing validation issue rather than part of this change.
