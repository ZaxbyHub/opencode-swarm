# Safer lane settlement and session close confirmation

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
