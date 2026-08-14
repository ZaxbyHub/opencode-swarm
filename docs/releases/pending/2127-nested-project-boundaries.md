# Nested Git and OpenCode project boundaries

## What changed

- Nested Git repositories, linked worktrees, and submodules can now use their
  own `.swarm/` state even when an outer project already has `.swarm/`.
- A direct `.opencode/` directory can explicitly declare the same independent
  nested-project boundary.
- `save_plan`, evidence writes, scope declaration, task-status updates,
  `pre_check_batch`, and every tool using the shared working-directory resolver
  now agree on the selected nested root.
- Windows case-different paths use platform-aware descendant checks instead of
  case-sensitive string prefixes.
- Windows CRLF checkouts no longer make the engineering-invariants mock
  allowlist reject every valid `mock.module` target during local validation.
- The real-host knowledge integration test now isolates user-level data roots,
  preventing a developer's existing knowledge hive from crowding out fixtures.

## Safety behavior

Ordinary subdirectories are still rejected. A boundary marker must be a direct
`.git` file/directory or direct `.opencode/` directory. Direct markers are local
declarations, so an empty or malformed `.git` marker still opts in; marker
symlinks/junctions and inaccessible markers do not. Inaccessible ancestor
`.swarm` or project-indicator state fails closed rather than widening where
runtime state can be written.

All accepted runtime state remains contained under `<nested-root>/.swarm/`; it
is never redirected into the outer project.

Plan, scope, evidence, and evaluation persistence now repeat the canonical
project-root assertion at every low-level mutation, including checkpoints,
recovery/terminal writers, migration, deletion, retirement, retention/archive,
and lock-target creation, so callers cannot bypass the tool-layer guard.
Ambiguous ancestor project-indicator errors report that inaccessible state
directly, and an exhausted bounded ancestor walk fails closed instead of
granting authority.

## Migration

No migration or configuration change is required. Existing project roots and
ordinary-subdirectory rejection keep their prior behavior.

Closes: #2127
