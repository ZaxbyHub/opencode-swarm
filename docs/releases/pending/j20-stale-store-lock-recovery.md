---
issue: 2967
---

# Stale store locks recover on restart (#2967, Workstream J slot J20)

A hard kill (crash, host death, `kill -9`) mid-write used to leave the
evidence/plan-ledger lock and the events-store lock held by a process that no
longer existed: every subsequent write stalled for the full 60 s lock budget
(`EvidenceLockTimeoutError`) or failed fast (`CORE_EVENT_STORE_LOCKED`) until
the 5-minute TTL stole the artifact — on the very stores the resumability
promise rests on.

The lock substrate now carries the owner identity INSIDE the lock file
(`.swarm/locks/<sha256>.lck`, wx-created with a pid/start-time/nonce payload),
and contention runs one fenced liveness break: a lock whose owner process is
provably dead (ESRCH) is broken in milliseconds with one bounded telemetry
event (`store_lock_stale_broken`) and a per-target cooldown; a LIVE owner is
never touched, paused or not — strictly safer than the old TTL steal, which
broke any 5-minute-old lock with no liveness check at all. Breaking is
serialized by rename-atomic markers, releases are identity-fenced (a late
release can never delete a successor's lock), and ownerless legacy locks keep
today's TTL-only behavior through the same protocol. Lane locks migrate onto
the identical substrate (one mutually exclusive protocol per target); the
events store adopts the same payload-writing two-phase acquire, dropping its
raw mtime stale-break. The PID-reuse corner (a dead holder's pid recycled by
a long-lived unrelated process) is report-only via `/swarm config doctor
--integrity` — surfaced, never auto-removed. One disclosed upgrade window:
during a mixed-version deployment, an OLD-code writer that starts after this
version's legacy probe completes holds only the legacy proper-lockfile
artifact, so mutual exclusion between that old writer and a new-code holder
of the same target is best-effort for the duration of the upgrade.

## Review feedback round (PR #3533 post-review hardening)

The independent review round hardened the substrate further:

- **Stale recovery now covers every lock target.** The fenced breaker was
  wired only into the evidence/events wrappers; a dead owner's `.lck` on a
  plan/save target wedged that target permanently. The plain acquire path
  now probes the payload on contention and runs the same fenced, never-
  break-live-pid breaker for dead owners (cooldown-bounded).
- **Lane identity is projected again.** `listActiveLocks` reads the `.meta`
  sidecar so the lean lane gates (phase-ready / task-completion) see held
  lane locks; a lane release keeps the meta when the fence refuses (no more
  orphaned live locks without bookkeeping) and releases pre-upgrade legacy
  lane locks through their `.lock` pairing.
- **Break markers are atomic and swept.** The break right is published via
  a unique candidate file + no-replace hardlink (a mid-publish marker can
  no longer be read half-written and taken over), unparsable markers are
  never taken over, and `cleanupExpiredLocks` plus the doctor sweep aged
  `.breaking`/`.take.` residue; the cooldown budget is only consumed once a
  break is actually attempted, and expiry is test-pinned.
- **The doctor sees the events lock.** `.swarm/events.lock` (and break
  markers) are classified by `/swarm config doctor --integrity`; the report
  strips control characters from echoed names, skips symlinks, bounds its
  reads/walks, mirrors the strict v1 payload validation, and its torn-tail
  window now covers the legal 256 KiB max line.
- **Telemetry emit path stays fast.** The OTLP spool write caps its rename
  retry schedule at ~85 ms (was up to 385 ms of synchronous sleeps on the
  emitting thread), and terminal failures now assert the no-clobber
  invariant in tests driven through the real retry helper.
