# Fix: stale worktree path used as a spawn `cwd` reported itself as "git is missing"

## What

`update_task_status` could fail deterministically with

```
ENOENT: no such file or directory, posix_spawn 'git'
```

on a machine where git was installed and working, deadlocking the session: the task-completion gate requires
`update_task_status`, and `update_task_status` was the thing that could not run.

git was never missing. The error came from a **spawn whose `cwd` no longer existed**.

`recoverCoderSettlement` reconstructs a dispatch from the durable write-ahead log at
`.swarm/coder-settlements/<taskId>.json` and passed `descriptor.worktreePath` straight into a subprocess `cwd`
without checking the directory still existed. When the lane worktree had already been torn down, the spawn
failed with `ENOENT` and the raw error reached the user. Because the WAL is on disk, every retry re-read the
same dead path and produced the identical error — which is why it looked deterministic and why clearing session
state did not help.

Under Bun the two failures are distinguishable, and the distinction is the whole diagnosis:

| condition | message |
| --- | --- |
| git binary genuinely absent | `Executable not found in $PATH: "git"` |
| git present, `cwd` missing | `ENOENT: no such file or directory, posix_spawn 'git'` |

The reported string is the second one.

## Fixes

- **`bunSpawn` now honors its own documented cross-runtime contract.** Its Node path already reported
  process-creation failures via `spawnError` with a non-zero exit; its Bun path threw synchronously instead.
  The Bun path no longer throws — process-creation failures are described by `spawnError`, as the contract in
  that file always said. This was the channel that leaked the raw message.
- **A spawn that cannot start is classified, not guessed.** `ENOENT` is no longer treated as "git binary
  missing" unconditionally. A missing or non-directory `cwd`, and a `cwd` that cannot be read at all
  (`EACCES`/`EPERM`), are now distinct outcomes with distinct messages — the third case never silently
  collapses into either of the others.
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

## Also fixed

- **macOS sandboxing never activated.** Both availability probes ran `sandbox-exec --version`; `sandbox-exec`
  has no `--version` flag, so both probes failed on every macOS host and shell commands silently ran
  unsandboxed. The probes now use a valid invocation and agree on a single success criterion. The macOS
  sandbox is opt-in via `sandbox.macos_enabled` (default off) until the sandbox profile is verified on real
  macOS hardware.
- **Sandbox environment hardening is now applied on macOS.** `getEnvOverrides()` was implemented by every
  executor and called by none, so the `DYLD_*` injection variables it strips were never actually stripped.
- **`update` no longer reports caches it did not clear.** Version-pinned cache directories
  (`opencode-swarm@<version>`) are now discovered and cleared, deletion is verified rather than assumed, and
  the version that was removed is reported. The running plugin version is logged at startup.
- **Three tools no longer mistake a failed spawn for an empty result** — including a package-audit path that
  could report a clean audit when the scanner never ran.

## Hardening

git, `gh`, `sandbox-exec` and `bwrap` are no longer spawned by bare name. Every call site resolves an absolute
executable path first, with a new `git.binary` config option and `OPENCODE_SWARM_GIT_BINARY` environment
override for hosts where discovery needs help. A CI check (`check:bare-spawn`) fails the build on any new
bare-name spawn outside the resolver, so the class cannot return quietly.

This part addresses the fix originally requested in the issue. It was **not** the cause of the reported
failure, and is included because it closes a real latent problem on hosts with an unusual `PATH`.
