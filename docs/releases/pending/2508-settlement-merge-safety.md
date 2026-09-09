# Safer lane settlement and session close confirmation

- Standard lane settlement now produces a reviewable squash artifact without
  overwriting the primary branch's existing index or worktree changes.
- `/swarm finalize` and its `/swarm close` alias preview the exact destructive
  cleanup and Git-alignment scope and require a single-use
  `--confirm=<token>` before applying it. The scope is revalidated after the
  finalize lock, so changed files, ignored build artifacts, or branch-prune
  targets abort safely.
