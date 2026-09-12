# Memory cohort migration destination locking (#2577)

## What changed

- `/swarm memory link` and `/swarm memory unlink` migrations now fail closed
  when the destination storage-directory lock cannot be acquired, instead of
  proceeding unlocked after the lock acquisition failure was silently
  swallowed.
- The failure is typed (`MemoryMigrationLockError` with a `contention` or
  `storage` category and a stable code), bounded, and retryable: the shared
  acquisition retry budget (~4.2 s) is honored first, and the surfaced message
  tells the user to retry the command.
- Destination and source stores are preserved byte-for-byte on a failed
  admission — no partial merge, no `backups/` litter — and a held live lock is
  never stolen.
- Added deterministic held-lock, taxonomy, serialization, retryable-admission,
  and idempotency regression coverage.

## Why

The migration engine caught every destination-lock acquisition failure
(including `ELOCKED` after the bounded retries) and ran the destination
read/merge/write without the lock, so a legitimate concurrent writer on the
same storage directory — the local JSONL provider, a sibling worktree's link,
or a peer unlink — was not excluded and rows appended between the migration's
read and write were silently dropped while the command reported success
(issue #2577, audit FUNCTIONAL-6).
