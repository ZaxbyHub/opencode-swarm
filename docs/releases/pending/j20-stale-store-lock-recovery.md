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
