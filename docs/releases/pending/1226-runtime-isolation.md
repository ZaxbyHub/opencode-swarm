# Per-lane runtime isolation (opt-in)

## What

Adds per-lane runtime isolation on top of worktree lane isolation. When enabled
via `worktree.runtime_isolation.enabled: true`, each parallel lane gets:

- **Port allocation**: `PORT = port_base + laneIndex * port_stride` (default
  port_base=3000, port_stride=10). Prevents port conflicts when lanes run
  dev servers or test suites simultaneously.
- **Environment variable overrides**: `env_overrides` map applied per-lane.
  Null values unset the var; non-null values override. All keys validated by
  `isValidEnvKey` POSIX regex.
- **Cache redirects**: `cache_redirects` paths suffixed with `lane-{index}`
  to isolate npm/bun caches, tmp dirs, etc.
- **Lane profile files**: Materialized to `.swarm/lanes/{n}.env` and removed
  at teardown.

Sandbox executor support:
- Linux: bubblewrap `--setenv` injection
- macOS: sandbox-exec SBPL profile generation
- Windows: restricted-environment PATH + env scoping

Init orphan recovery runs at plugin startup with cross-process advisory lock
safety, bounded by a 10-second timeout.

## Why

Parallel lanes sharing the same runtime environment (PORT, cache dirs, env
vars) cause collisions, stale-cache bugs, and port conflicts. Runtime isolation
gives each lane a deterministic, conflict-free environment without requiring
users to manually manage ports or caches.

## Notes

- Feature is opt-in (`runtime_isolation.enabled` defaults to `false`)
- `turbo.lean.worktree_isolation` default changed to `true` (see
  `1226-lean-worktree-default.md`)
- New `/swarm lanes` command shows active, awaiting-merge, and conflicted lanes

Refs #1226
