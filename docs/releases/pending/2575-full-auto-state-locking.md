# Full-Auto durable-state locking (#2575)

## What changed

- Replaced the unsupported positive `proper-lockfile` sync retry option with a
  bounded caller-owned `ELOCKED` backoff schedule.
- Full-Auto read/modify/write updates now fail with typed contention,
  configuration, or storage errors instead of proceeding unlocked.
- Added deterministic single-process, held-lock, taxonomy, and independent
  worker regression coverage.

## Why

The synchronous lock adapter rejects positive retry options with `ESYNC`; the
previous fallback then ran the state mutation without a lock, allowing lost
updates across processes and reporting false success while a live lock was
held.
