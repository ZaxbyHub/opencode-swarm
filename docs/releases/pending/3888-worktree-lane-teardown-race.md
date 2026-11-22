---
issue: 3888
---

Standard-worktree teardown no longer destroys a lane that a newer, live dispatch
of the same task owns. Consecutive same-task coder dispatches reuse one lane
path and branch by design; a delayed teardown of the earlier dispatch (its
settlement still in flight, or the settlement-cleanup WAL re-run) could delete
the live child's lane directory mid-run — every filesystem access in the lane
then failed with `disk I/O error` (EIO) — and delete the shared lane branch.

Teardown now re-validates lane ownership under the worktree lifecycle lock
before any destructive step, at all three standard teardown sites: the standard
cleanup entry point (before dirty-preservation, so preservation can also never
commit inside a re-provisioned lane), the delegation-gate terminal-failure
branch, and the startup dead-lane reclaim sweep for stranded lanes.
A confirmed re-provision (a live dispatch map entry, or a provisioning-owner
marker for the lane) skips worktree removal, branch deletion and the durable
live-owner-record clear, drops only the superseded dispatch's own tracking,
and emits a `STANDARD_WORKTREE_CLEANUP_SKIPPED_REPROVISIONED` advisory. An
unreadable ownership inventory fails closed: no destruction, tracking entries
retained, the settlement WAL stays retryable, and a
`..._OWNERSHIP_UNCERTAIN` advisory is emitted. When the lifecycle lock is
held by another holder, teardown fails toward preservation
(`STANDARD_WORKTREE_CLEANUP_LOCK_BUSY_PRESERVED`). Settlement, completion
observation and coder-settlement verification treat a confirmed skip as
success-equivalent and an uncertain skip as retryable debt.
