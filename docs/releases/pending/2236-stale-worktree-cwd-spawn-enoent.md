# Fix: stale worktree path used as a spawn `cwd` reported itself as "git is missing"

## What

`update_task_status` could fail deterministically with

```
ENOENT: no such file or directory, posix_spawn 'git'
```

on a machine where git was installed and working, deadlocking the session: the task-completion gate requires
`update_task_status`, and `update_task_status` was the thing that could not run.

git was not missing. The evidence points to a **spawn whose `cwd` no longer existed**.

`recoverCoderSettlement` reconstructs a dispatch from the durable write-ahead log at
`.swarm/coder-settlements/<taskId>.json` and passed `descriptor.worktreePath` straight into a subprocess `cwd`
without checking the directory still existed. When the lane worktree had already been torn down, the spawn
failed with `ENOENT` and the raw error reached the user. Because the WAL is on disk, every retry re-read the
same dead path and produced the identical error — which is why it looked deterministic and why clearing session
state did not help.

The failing path is narrower than "any stale WAL": it needs a WAL interrupted *after* `onBeforeMerge` persisted
both `observedFiles` and `mergeProvenance`, and it is **Bun-path only** — on the Node path the same stale `cwd`
already degraded gracefully.

Under Bun the two failures are distinguishable, and the distinction is the whole diagnosis:

| condition | message |
| --- | --- |
| git binary genuinely absent | `Executable not found in $PATH: "git"` |
| git present, `cwd` missing | `ENOENT: no such file or directory, <syscall> 'git'` |

The reported string is the second shape. (Reproduced locally on Windows, where the syscall is named `uv_spawn`;
the reporter's macOS string names `posix_spawn`. Same libuv failure, platform-specific syscall name.)

## Fixes

- **`bunSpawn` now honors its own documented cross-runtime contract.** Its Node path already reported
  process-creation failures via `spawnError` with a non-zero exit; its Bun path threw synchronously instead.
  The Bun path no longer throws. This was the channel that leaked the raw message.
- **A spawn that cannot start is classified, not guessed.** `ENOENT` is no longer treated as "git binary
  missing" unconditionally. A missing or non-directory `cwd`, and a `cwd` that cannot be inspected
  (`EACCES`/`EPERM`, or any other stat failure), are now distinct outcomes with distinct messages — the third
  case never silently collapses into either of the others.
- **"git could not start" is never reinterpreted as a fact about the repository.** Two callers asked git
  whether a path exists in `HEAD` and treated *any* failure other than a missing binary as the answer "no, it
  is a new file" — so a torn-down working directory produced a semantic diff claiming every file had just been
  added, rather than an honest failure. The semantic-diff block injected into reviewer context
  (`src/hooks/semantic-diff-injection.ts`) and the `diff_summary` tool (`src/tools/diff-summary.ts`) now abort
  on every "the process never ran" outcome, missing binary and `cwd` fault alike. A git process that genuinely
  ran and reported the path is absent still takes the new-file path, unchanged.
- **Recovery prefers the branch over the directory.** A missing lane worktree no longer means the work is
  lost: the merge runs from the primary repository against the lane branch, which is where the coder's commits
  actually live. The dirty-state prelude is skipped (there is no working tree left to commit) but the
  merge-safety check that refuses to merge a branch that moved since provenance was recorded is preserved,
  reading the lane head from the primary repository instead of the deleted directory.
- **The stale worktree registration is pruned before branch deletion.** Without this, cleanup fails with
  `cannot delete branch 'X' used by worktree at ...` and the session deadlocks again with a different message.
- **The write-ahead log self-heals only when nothing is recoverable**, and says what it repaired. It is never
  marked terminal while the lane branch still exists, or while branch existence cannot be determined —
  stranding a coder's commits on an orphan branch is worse than staying blocked.

## Compatibility note

On the Bun runtime, a `bunSpawn` process-creation failure is now a **value rather than a throw**: the returned
subprocess reports `exitCode: null`, its `exited` promise resolves non-zero, and the reason is available on
`spawnError` (and replayed on `stderr`). Callers that previously relied on a synchronous throw landing in a
`catch` will now see a subprocess that exited non-zero with a diagnostic. This matches what the Node path has
always done, and is the most cross-cutting change here.

## Also fixed

- **macOS sandboxing never activated.** Both availability probes ran `sandbox-exec --version`; `sandbox-exec`
  has no `--version` flag, so both probes failed on every macOS host and shell commands silently ran
  unsandboxed. The probes now use a valid invocation and agree on a single success criterion (exit code).
  The macOS sandbox is **opt-in** via `guardrails.sandbox_macos_enabled` (default `false`) until the sandbox
  profile is verified on real macOS hardware. Note that `/swarm diagnose` on macOS now actually spawns
  `sandbox-exec` to probe it.
- **Sandbox environment hardening is now applied on macOS when the sandbox is enabled.**
  `getEnvOverrides()` was implemented by every executor and called by none, so the `DYLD_*` injection variables
  it strips were never actually stripped. With `guardrails.sandbox_macos_enabled` left at its default, no
  executor is constructed and this hardening does not apply.
- **`update` no longer reports caches it did not clear.** Version-pinned cache directories
  (`opencode-swarm@<version>`) are now discovered and cleared, deletion is verified rather than assumed, and
  the version that was removed is reported. The running plugin version is logged at startup.
- **Three tools no longer mistake a failed spawn for an empty result** — including a package-audit path that
  could report a clean audit when the scanner never ran.

## Hardening

No call site spawns a hardcoded bare `git`, `gh`, `sandbox-exec` or `bwrap` literal any more. Each routes
through a resolver that prefers an absolute executable path, with a deliberate bare-name fallback last so no
host that works today regresses — on macOS and Linux the `gh` resolver still has the bare name as its only
candidate. A new `git.binary` config option and `OPENCODE_SWARM_GIT_BINARY` environment override let a host
point at a specific binary. First resolution probes candidates with `git --version` under a 250 ms per-probe /
1 s total budget, caching the result (a failure is re-probed after 60 s).

**`git.binary` is honored only from the user-level config and the environment variable.** A value set in a
repository's `.opencode/opencode-swarm.json` is dropped with a warning and never used: that file lives inside
the repo, so a repository could otherwise ship both a config naming a shim and the shim itself, and the shim
would run with the user's privileges on the next git command (CWE-427). There is no per-repository form of
this option. Independently of provenance, a candidate is now accepted only when `--version` exits 0 **and**
prints git's own `git version <major>.<minor>…` line — exiting 0 is no longer enough for any candidate source,
so an arbitrary executable cannot be mistaken for git. A refused or unusable value is still never fatal:
resolution warns and continues down the candidate list.

A CI check (`check:bare-spawn`) fails the build on any new bare-name **string literal** in a spawn call outside
the resolver. It matches literals, so a bare name carried through a variable is out of its reach.

This part addresses the fix originally requested in the issue. It was **not** the cause of the reported
failure, and is included because it closes a real latent problem on hosts with an unusual `PATH`.
