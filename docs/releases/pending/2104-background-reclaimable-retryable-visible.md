## [Guardrail remediation 9/12] Make background work reclaimable, retryable, and visible (issue #2104)

Opt-in reservation recovery and status visibility for background delegations, plus a queue
ownership repair. No issue is closed by this change (guardrail remediation coordination).

### AutomationQueue in-flight ownership

`AutomationQueue.dequeue()` used `shift()`, so `retry(id)` after dequeue found nothing and
silently returned `false` — every transiently failing dequeued item was dropped instead of
re-enqueued (`WorkerManager.handleItem` is the propagation site; latent because no production
worker is registered). The queue now tracks dequeued items in a bounded in-flight set until they
settle: an item exists in exactly one of queued / in-flight / terminal state; `retry` increments
attempts once per failed execution, honours exponential backoff before the item can be dequeued
again, and exhaustion emits exactly one terminal `queue.item.failed`; `complete` is exactly-once
and immune to ID recycling through a bounded terminal registry; `clear()` has an explicit
in-flight drop policy; the in-flight set is bounded by `maxSize`. `WorkerManager.stop()`
documents its deterministic in-flight policy (handlers run to completion and settle through the
in-flight map) and `getStats()` exposes `queueInflight`. No production worker is registered.

### Generation-bound coder-reservation leases

`BackgroundCoderReservation` gains `generation` and `leaseExpiresAt` (both optional, so legacy
stores keep parsing and legacy reservations stay readable as generation 1). Leases are created
only after every admission/capacity check passes, with documented bounded constants (default
15 min, hard max 60 min, floor 60 s; inputs clamped). Binding couples the reservation to the
delegation record's launch generation (forward-only); renewal requires the exact owner identity
and the same generation; a terminal for an older generation can never rebind, renew, or release
a newer reservation. Legacy reservations without a lease are never released by age.

### Event-driven bounded maintenance

A new shared `maintainBackgroundDelegations` service runs at six call sites covering five event
triggers: before background coder admission (P1, 1 s lock-acquire bound, skipped on contention —
inline proven-terminal reconciliation still guards admission), after a trusted terminal claim
(P2) and after a durably recorded ingestion rejection (P2b), on terminal session events (P3,
2 s), from the opt-in status path (P4, 2 s), and as a deferred post-init task (P5, wrapped in a
10 s withTimeout, registered only when `hooks.background_subagents` is enabled). Each invocation
bounds the reservation-reconciliation loop to a record batch (default 256); the underlying
reads are themselves size-capped by the existing checkpoint machinery and the 4 MiB recovery
window, and the lock bounds cap the lock *acquire* wait (total hold time is additionally
bounded by those read caps). Changes serialize under the existing store locks (taken
sequentially, never nested), and every release, retained ambiguity, renewal, contention, and
failure emits a durable operator fact into the health artifact's bounded maintenance ring
(latest 20; the latest facts are also rendered by the opt-in status section). Reclaim requires
corroborated owner evidence — a durably stale exact owner record, or no owner record anywhere
beyond the stale window — never wall-clock age alone; uncertain owner evidence retains
everything fail-closed.

### Rollback / downgrade note (opt-in users)

Reservation records written by this version carry two new fields (`generation`,
`leaseExpiresAt`). A pre-#2104 plugin version reading such a store rejects the unknown keys
under its strict schema, so background coder admission fails closed
(`BACKGROUND_CODER_RESERVATION_UNCERTAIN`) until the store is cleared. If you downgrade while
`hooks.background_subagents` was enabled, delete `.swarm/background-coder-reservations.json` —
reservations are transient admission state, and live slots remain correctly bounded by the
durable delegation-owner scan, so deleting the file cannot over-admit a live task.

### Opt-in `/swarm status` background-work section

When `hooks.background_subagents` is enabled, `/swarm status` now shows delegation counts
(pending, running, completed-unconsumed, consumed, stale, cancelled, error, ingestion_error),
active reservations with their generation and lease state (active / expired / protected-legacy),
the durable maintenance summary (last ok, last failure, last lock contention), and a
provenance label. All reads are bounded (recovery scan + bounded reservation store + health
artifact); corrupt or over-bound stores render typed uncertainty instead of partially-trusted
counts. When the feature is disabled (the default), status output is unchanged — no section, no
maintenance, no deferred init work.
