# /swarm finalize git detection and subprocess safety fix

## What changed

- **`gitExec` subprocess safety** — `src/git/branch.ts` now uses `stdio: ['ignore','pipe','pipe']` and `windowsHide: true`, and checks `result.error` before `result.status`. This eliminates false "Not a git repository" errors caused by piped stdin blocking git subprocesses on Windows.
- **`checkpoint.ts` subprocess safety** — The same `gitExec` fix was applied to `src/tools/checkpoint.ts`. It also now passes an explicit `cwd` to git subprocesses instead of relying on inherited `process.cwd`.
- **Help text correction** — `src/commands/registry.ts` and `docs/commands.md` were updated. `/swarm finalize` no longer claims "safe git ff-only to main"; it now accurately describes the destructive `git reset --hard` / `git clean -fd` alignment behavior.

## Why

The previous `stdio: ['pipe','pipe','pipe']` left stdin as a pipe, which on Windows can cause git subprocesses to block waiting for input. This produced a false "Not a git repository" error even in valid repositories. Checking `result.error` before `result.status` ensures spawn-level failures (ENOENT, permission errors, etc.) are surfaced correctly instead of being masked by a missing exit status.

The `checkpoint.ts` explicit `cwd` fix removes reliance on inherited `process.cwd`, which is fragile in plugin-hosted contexts where the host process cwd may not be the project root.

The help-text correction prevents users from being misled about finalize's behavior. Finalize aligns the working tree with the approved plan using destructive git commands; describing it as a "safe ff-only merge" was inaccurate and could cause data loss.

## Migration steps

None. The fix is transparent to users. If you have scripts or documentation that assumed `/swarm finalize` performs a safe ff-only merge, update them to reflect the actual destructive cleanup behavior.

## Known caveats

- `/swarm finalize` still performs destructive cleanup (`git reset --hard` and `git clean -fd`) to align the working tree with the approved plan. Ensure uncommitted work is stashed or committed before running finalize.
- The subprocess fix does not change the finalize git flow itself; it only corrects repository detection and error reporting.
- On Windows, `windowsHide: true` suppresses the console window that may otherwise flash when git subprocesses are spawned from a GUI/TUI host.
