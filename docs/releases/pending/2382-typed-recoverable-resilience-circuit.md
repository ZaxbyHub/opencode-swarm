# PR review 2/5: typed recoverable resilience circuit

The PR-review resilience circuit no longer opens on heuristics. It now counts
only durable, typed terminal provider failures, and the persisted circuit is a
versioned, recoverable state machine instead of a dead-end flag.

## Typed failure evidence

- Lanes settled as errors now persist a bounded structured classification
  (`terminalErrorClass`: SDK discriminator kind, canonical failure category,
  status code, host-retryable flag) alongside the display reason.
- Only that structured evidence can contribute a `provider_terminal` signal.
  Observer deadlines, missing host clients, parser rejections, policy gates,
  filesystem/Git errors, cancellations, and presumed-stale observations are
  ignored kinds that can never open, reopen, or close the circuit, and display
  text is never parsed as evidence.

## Distinct-lane threshold

- The `correlated_failure_threshold` now counts distinct
  `(generation, batchId, laneId)` contributor lanes per provider class. One
  consolidated lane owning all six review dimensions contributes one sample,
  and repeated collections of one failed lane are idempotent. Different
  provider classes do not correlate.

## Versioned, recoverable circuit state

- The persisted circuit record is versioned (`version: 2`) and carries a
  `CLOSED | OPEN | HALF_OPEN` lifecycle with a bounded contributor ledger
  (deterministic keep-newest eviction), an evidence waterline, and a
  generation counter. Late results from older generations cannot mutate
  current state.
- After `circuit_open_duration_ms` (new setting, default 60 seconds, range
  1000–1800000), the circuit admits exactly one recovery canary probe —
  atomically, even under concurrent dispatches. A typed provider failure
  reopens with a fresh interval; a typed success closes the circuit, clears
  the evidence through the waterline, and bumps the generation; an ignored
  probe outcome restarts the cooldown without changing any circuit state.
  Collect, diagnose, cancel, abort, gap reporting, and config changes remain
  reachable while the circuit is open.
- Unversioned circuits persisted by older builds migrate once to a closed,
  non-blocking record with waterlined historical evidence; malformed records
  fail open with a bounded, hash-only debug diagnostic.

## Authoritative live disable

- The current `pr_review_resilience.enabled` value now always wins: flipping it
  to `false` disarms an already-admitted workflow immediately instead of a
  first-persisted policy snapshot keeping resilience semantics alive. The
  persisted record survives for audit, and re-enabling later starts from a
  clean closed generation that cannot resurrect pre-disable evidence. Numeric
  knobs keep their admitted-workflow snapshot.

Closes #2382 (PR 2 of the #2380 PR-review repair program; parent incident
#2375).
