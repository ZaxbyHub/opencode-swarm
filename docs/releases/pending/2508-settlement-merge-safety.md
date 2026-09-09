# Safer lane settlement and session close confirmation

- Standard worktree lane settlement now defaults to `merge_strategy: "squash"`
  for a reviewable synthetic result tree; Lean Turbo keeps its historical
  `merge` default unless explicitly configured otherwise.
- Squash settlement requires Git 2.38 or newer because it uses
  `git merge-tree --write-tree`; older Git versions fail closed with an
  unsupported-Git result and do not mutate the target worktree.
- Standard lane settlement now produces a reviewable squash artifact without
  overwriting the primary branch's existing index or worktree changes.
- Crash recovery now publishes durable squash-lane authority before cleanup,
  so retained review branches remain protected from orphan pruning.
- Persisted recovery authorities are integrity-checked before any retained
  branch cleanup, and committed-WAL recovery republishes squash authority
  before removing the recovered worktree.
- `/swarm finalize` and its `/swarm close` alias preview the exact destructive
  cleanup and Git-alignment scope and require a single-use
  `--confirm=<token>` before applying it. The scope is revalidated after the
  finalize lock, so changed files, ignored build artifacts, or branch-prune
  targets abort safely.
