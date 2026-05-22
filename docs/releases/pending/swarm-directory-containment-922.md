# Fix: .swarm directory containment enforcement

## What changed
- Fixed the root cause of issue #922: `pre_check_batch` workspaceAnchor was set to the user-supplied `args.directory` value instead of the injected project root from `createSwarmTool`. This caused `.swarm/` directories to be created in subdirectories like `src/`, `src/hooks/`, etc.
- Eliminated ALL `process.cwd()` fallbacks from 7 tool files: `pre-check-batch`, `test-impact`, `update-task-status`, `declare-scope`, `mutation-test`, `diff-summary`, and `resolve-working-directory`.
- Added `validateProjectRoot` defense-in-depth guard to `saveEvidence` in `evidence/manager.ts`. This function uses `realpathSync` to walk up the directory tree and rejects writes to directories whose parents already contain `.swarm/`.
- Added subdirectory containment guards to `update-task-status` and `declare-scope` using `realpathSync` canonicalization of both the working directory and the injected project root.
- Added stray `.swarm` directory detection and cleanup to `/swarm doctor` and `/swarm config doctor`. The `detectStraySwarmDirs` function recursively walks the project tree (max depth 10, skips `node_modules/.git/dist/.cache`) and reports stray directories. The `--fix` flag triggers automatic cleanup.
- Added defense-in-depth documentation to `resolve-working-directory.ts` explaining the relationship to `validateProjectRoot`.

## Why
Issue #922 reported that `.swarm/` directories were being created in project subdirectories (`src/`, `src/hooks/`, `src/prm/`), causing state pollution and confusion. The root cause was `pre_check_batch` using the user-supplied directory argument as the workspace anchor instead of the injected project root. Multiple tools also had `process.cwd()` fallbacks that could bypass project-root anchoring.

## Migration
No migration required. Existing stray `.swarm/` directories can be detected and cleaned up by running `/swarm doctor --fix`.

## Known caveats
- `detectStraySwarmDirs` has a depth limit of 10 levels, which may miss strays in deeply nested monorepos. This is a detection gap only — creation prevention works at any depth.
- `resolveWorkingDirectory` intentionally avoids `realpathSync` for the resolved path to prevent Windows 8.3 short filename issues. The write-time `validateProjectRoot` guard (which does use `realpathSync`) catches any symlink-based bypasses.
- Case-sensitive `.swarm` checks on Windows will not match directories named `.SWARM` or `.Swarm`.
