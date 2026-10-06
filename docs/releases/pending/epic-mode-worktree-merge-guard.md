# Epic Mode: durable worktree merge-back status guards the epic's waves

## What changed

- New leaf module `src/hooks/delegation-gate/worktree-merge-status.ts`: a
  **durable** registry of worktree merge-back outcomes. Worktree isolation
  (the writer) records a `partial` / `failed` outcome keyed by plan task id
  and clears it when a later re-dispatch of the same task merges cleanly.
  State is kept in memory (fast path) **and** persisted atomically to
  `.swarm/worktree-merge-status.json`, so a plugin restart after a failed
  merge-back does not lose the record.
- `finishStandardWorktreeDispatch` (and the hard-throw path in
  `delegation-gate.ts`) record every merge-back outcome into the registry.
- Epic Mode reads it (see `epic-mode-v2.md`): while a completed task of the
  active wave has a failure recorded since the wave was issued,
  `epic_next_wave` does not close the wave (`blocked: merge-failed`), and
  completing an epic task whose merge-back failed skips the #2582
  auto-checkpoint with a critical warning (its HEAD would not contain the
  task's work). The plan status update still persists (the ledger is
  authoritative). A clean re-dispatch clears the record;
  `/swarm epic clear-merge-failure <taskId> --confirm` clears one that no
  longer reflects reality.

## Why

A coder isolated in a git worktree whose merge-back fails leaves its work
stranded in the preserved worktree. Without a durable record, an epic could
advance past work that never reached the epic branch.

## Compatibility

- No behavior change unless an epic is open **and** a worktree merge-back
  fails or only partially lands. Projects without an open epic only gain the
  durable status file.
