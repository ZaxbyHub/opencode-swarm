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

A new shared `maintainBackgroundDelegations` service runs at five production points: before
background coder admission (1 s lock bound, skipped on contention — inline proven-terminal
reconciliation still guards admission), after a trusted terminal claim or ingestion rejection,
on terminal session events, from the opt-in status path, and as a deferred post-init task
(time-bounded 10 s, registered only when `hooks.background_subagents` is enabled). Each
invocation is batch-bounded, serialized under the existing store locks (taken sequentially,
never nested), and emits a durable operator fact for every release, retained ambiguity,
renewal, contention, and failure into the health artifact's bounded maintenance ring (latest
20). Reclaim requires corroborated owner evidence — a durably stale exact owner record, or no
owner record anywhere beyond the stale window — never wall-clock age alone; uncertain owner
evidence retains everything fail-closed.

### Opt-in `/swarm status` background-work section

When `hooks.background_subagents` is enabled, `/swarm status` now shows delegation counts
(pending, running, completed-unconsumed, consumed, stale, cancelled, error, ingestion_error),
active reservations with their generation and lease state (active / expired / protected-legacy),
the durable maintenance summary (last ok, last failure, last lock contention), and a
provenance label. All reads are bounded (recovery scan + bounded reservation store + health
artifact); corrupt or over-bound stores render typed uncertainty instead of partially-trusted
counts. When the feature is disabled (the default), status output is unchanged — no section, no
maintenance, no deferred init work.
