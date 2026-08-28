# PR-monitor subscription store: recovery-path hardening (#2408 follow-up)

Hardens the bounded PR-monitor subscription checkpoint store shipped in #2408,
closing the blockers and should-fixes from its post-merge review.

## What changed

- **Aborted migration scans never archive data**: an I/O failure (transient
  ENOENT/EBUSY/EPERM-class) while scanning the legacy `subscriptions.jsonl` log
  is now detected (`aborted` flag) instead of being silently treated as a
  complete scan. Migration stays incomplete and retries on the next store
  operation — an unread tail is never renamed into the archive and lost.
- **Recovery slots preserve history**: quarantining a foreign or corrupt
  checkpoint rotates the previous quarantined copy to a `.prev` slot (bounded to
  one generation) instead of deleting it — a second recovery event (e.g.
  renaming the project directory twice) no longer destroys the first event's
  only displaced copy.
- **Recovery resets are visible**: the reset counter now carries forward across
  recovery generations (monotone), and is surfaced in the `/swarm pr status`
  storage footer and the `pr_subscription_health` telemetry payload
  (`recovery_resets`). Foreign rebinds log the displaced-record count and the
  recorded root.
- **UTF-8 byte coherence**: checkpoint writer capacity guards and telemetry byte
  figures compare real UTF-8 bytes (`Buffer.byteLength`), matching the reader's
  `stat.size` gate — non-ASCII-heavy checkpoint content can no longer pass the
  write-time check and be rejected by the next read.
- **Archive TTL counts from archival**: legacy archives are stamped fresh at
  creation (`utimesSync`), so an idle legacy log's archive survives the full
  7-day retention window instead of being instantly TTL-eligible (rename
  preserves the old mtime).
- **Bounded read-bootstrap**: the one-time legacy read-bootstrap is attempted at
  most once per directory per process — under persistent lock contention,
  reads on legacy-only stores no longer pay the short lock wait on every call.

## Behavior notes

No public API or on-disk schema changes. `/swarm pr status` gains a `resets N`
segment in the storage footer. Renaming/moving the project directory re-binds
the store (fail-safe, unchanged from #2408) — subscriptions can be re-created
with `/swarm pr subscribe`, and the displaced checkpoint remains recoverable
from the quarantine slot pair.
