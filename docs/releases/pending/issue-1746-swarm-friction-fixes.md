Fixes several swarm workflow friction points from issue #1746: same-task lane
retries now clean stale worktree branches instead of adopting old state,
placeholder scans are diff-aware with sentinel allowances, Full-Auto oversight
retries transient server failures before pausing, reviewer set-dispatch output
can attribute gate evidence per task, PR monitor CI failures are batched after
checks complete, `/swarm pr status` surfaces recent merge-group run log access,
and `/swarm ci-simulate` can validate a merge-result worktree with fixed local
CI gates before merge-queue entry, including the same per-file unit isolation
used by CI.
