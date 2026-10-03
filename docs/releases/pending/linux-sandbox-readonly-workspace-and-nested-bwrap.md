# Linux sandbox: the workspace is readable inside, and a nested bwrap is refused

## What changed

1. `BubblewrapSandboxExecutor.wrapCommand` (`src/sandbox/linux/bubblewrap-executor.ts`)
   accepts `readonly_roots` on its policy argument and mounts each one with
   `--ro-bind` before the writable scope `--bind`s. The guardrails hook
   (`src/hooks/guardrails/tool-before.ts`) passes the session workspace
   directory there, canonicalized with `realpath` like the scope paths so a
   symlinked checkout mounts both at the same path. `SandboxPolicyOptions` (`src/sandbox/executor.ts`) gained
   the field; the configuration-derived subset used by the enforcement
   assessment and its cache key is now `SandboxConfigPolicy`, so the cache
   key is unchanged.
2. The guardrails hook refuses a bash call whose command is itself a `bwrap`
   invocation (bare name or `/usr/bin`, `/usr/local/bin`, `/bin` path,
   optionally behind `exec`/`env`) with `[sandbox] BLOCKED: the command
   already invokes bwrap ...` and the remedy, instead of wrapping it a second
   time. The refusal applies only to the Bubblewrap executor and only when the
   call is about to be wrapped (after the declared-scope and writable-roots
   checks); a call that would run unwrapped is not refused.

## Why

A coder's Linux sandbox bound only its declared scope paths (plus `/usr`,
`/lib`, `/lib64`, `/etc`). With scope on `tests/integration.test.js`, `ls js/`
inside the sandbox reported "No such file or directory" and
`node tests/integration.test.js` failed with `Cannot find module
'../js/rng.js'`. A coder could never run a test whose module under test lay
outside its write scope.

Because the wrapped command is written back into the tool arguments, the
host stores it as the agent's own tool input, and the coder copied the
`/usr/bin/bwrap ...` form into later calls. The plugin wrapped those again and
the inner bwrap failed with `bwrap: No permissions to create new namespace`,
a message that blames the kernel although unprivileged user namespaces were
allowed and a single bwrap worked. One project recorded 19 such failures out
of 71 wrapped calls in a day.

## Safety

- Bind order is verified against real bwrap in
  `tests/unit/sandbox/linux-workspace-readonly.test.ts` (skipped where bwrap is
  unavailable): a scoped file is writable, a sibling is readable, writing the
  sibling is denied (EROFS in a manual probe), creating a file in an unscoped
  directory is denied. The reverse order would have masked the scoped write.
- Only absolute, non-root roots are mounted; relative or `/` entries are
  dropped.
- The shell-write authority and scope checks that run before the wrap are
  unchanged; the read-only mount is a second layer, not the gate.
- macOS `sandbox-exec` and the Windows executors ignore `readonly_roots`.

## Known caveats

- `$HOME` outside the workspace is still not visible inside the Linux sandbox,
  so tools that need `~/.npm`, `~/.cache` or similar still run as before.
- A workspace under `/tmp` is hidden by the sandbox's private `/tmp` tmpfs,
  as the scope binds already were.
- Lane coders: only the lane root is mounted. A lane created with
  `deps_strategy: 'link'` has `node_modules` symlinked to the host project,
  which is outside the lane and stays invisible, so dependency imports still
  fail inside a lane sandbox. A lane's `.git` file points into the main
  repository's `.git/worktrees/`, so git commands also fail there. Neither is
  new; before this change nothing outside the scope was visible.
- The nested-wrapper refusal matches only a command that starts with `bwrap`
  (optionally behind `exec`/`env`), which is the form agents copy from the
  wrapped command. Forms such as `cd x && bwrap …` or `sudo bwrap` are still
  wrapped and fail at runtime with the original namespace error.
