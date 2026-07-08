# Unblock legitimate `git worktree remove --force` cleanup (#1708)

Phase 0 of the full-auto/sandbox epic (#1707). A legitimate `git worktree remove --force <path>`
was hard-blocked unconditionally by the destructive-command guard, even when the target was a
swarm-managed worktree — a guaranteed false positive, since git requires `--force` to remove any
worktree with uncommitted/untracked content (the normal state of an abandoned worktree awaiting
cleanup). Separately, swarm's own internal cleanup silently abandoned worktrees that failed
non-forced removal (observed as Windows `EBUSY`/`EPERM`), leaking them on disk indefinitely.

## Changes

- **Scope-aware guard for `git worktree remove --force`** (`src/hooks/guardrails/tool-before.ts`):
  the guard now parses the target path (handling `--force`/`-f` before or after the path, quoted
  or unquoted, and git's accepted abbreviation/stacking forms like `--forc`/`-ff`), canonicalizes
  it via `fs.realpathSync`, and allows the command only when the resolved target is inside the
  swarm-managed worktree base directory or a coder's declared scope — mirroring the existing
  `rsync --delete` exemption in the same function. Any other target, or a target that can't be
  parsed or resolved, is still hard-blocked (fail closed).
- **New shared helpers** (`src/worktree/core.ts`): `resolveWorktreeBaseDir()` and
  `isPathUnderSwarmWorktreeBase()` compute and check containment against the swarm worktree base
  (`config.worktree_dir` when set, else the default `<project-parent>/.swarm-worktrees/`), reused
  by both the guard and the internal cleanup path so they agree on what counts as swarm-managed.
- **Opt-in `--force` fallback in `removeWorktree()`** (`src/worktree/core.ts`): after non-forced
  removal attempts are exhausted, an opt-in `{ force: true }` option retries once with `--force` —
  restricted to targets inside the swarm worktree base; default (non-opt-in) behavior is unchanged.
  Wired into all four of swarm's own cleanup call sites (session-create-failure rollback,
  successful merge-back cleanup, and error-exit/shutdown lane cleanup in Lean Turbo), so genuinely
  stale in-root worktrees are now actually reclaimed instead of silently leaked.

## Migration

No migration required. This only affects `git worktree remove --force` invocations made through
the guarded bash/shell tool path, and swarm's own internal worktree cleanup.

## Known caveats

- The `declaredScope` exemption path (shared with the pre-existing `rsync --delete` exemption)
  does not canonicalize/realpath its target the way the new worktree-base check does — this is an
  existing, not newly-introduced, gap. A follow-up could harden both exemptions symmetrically.
- The swarm worktree base directory is always trusted even when a custom `worktree_dir` override
  is configured (in addition to the override), so a deployment that relocates worktrees away from
  the default location cannot fully de-trust that default path. Low-risk: it only affects
  force-removal of git-registered worktrees.
- `resolveWorktreeBaseDir()` does not reject a `worktree_dir` config value containing `..`
  traversal or an absolute path that escapes the project tree; this mirrors pre-existing behavior
  in `provisionWorktree()` and is a configuration footgun (not attacker-controlled), tracked as a
  follow-up.
