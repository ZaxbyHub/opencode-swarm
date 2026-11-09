---
issue: 3593
---

# Fail the observability append closed at the safe-integer generation ceiling

## What

The no-bump observability append (`appendObservabilityStateWhileLocked`) now
refuses to write when the durable `observabilityRevision` generation sits at
`Number.MAX_SAFE_INTEGER`: the append branch throws
`BLOCKED: PR workflow gate observability generation is exhausted at the
safe-integer ceiling; the durable row requires a manual generation reset`
instead of computing `+1` past the ceiling. The durable row is left untouched.

## Why

Follow-up 3593-R4 from PR #3593's retrospective: the ceiling guard was
RECORD'd during closure, and this lands it as approved hardening. At the
ceiling, a silently stable generation compares equal on every fresh read, so
fresh-read appends would pass the CAS and the same-revision stale-append
hole the generation exists to close would re-open. Reaching the ceiling is
not reachable in normal operation (~9 quadrillion appends on one session
row); a hand-tampered durable row is the only path, and appends are now
refused (fail closed) rather than silently degraded.

## Known limitations

- A ceiling-saturated row stays wedged for appends until an operator resets
  the generation manually — deliberate fail-closed, matching the gate's
  posture for unrecoverable durable-state corruption.
