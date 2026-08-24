## Fixed

- Made `/swarm close` reconcile every task against authoritative exact-task
  workflow evidence before archiving or cleanup. Verified success remains
  `complete`; unfinished work becomes the truthful non-success terminal
  `closed`, and terminal write failures now pause close without destructive
  follow-up.
- Bound close recovery records to a durable random plan epoch, made close crash
  recovery idempotent across every plan/evidence write window, and added an
  audited repair path for resuming closed tasks.
- Unified coder, repair, and terminal workflow recovery files behind bounded,
  strict, path-aware readers and corrected repair audit idempotency to key on
  both task and transition identity.

## Migration

- No routine configuration change is required. If recovery finds a preserved
  legacy coder-settlement WAL larger than 64 MiB, reconcile its task lane (or
  reduce and partition the declared scope) before moving that WAL aside; do not
  delete unresolved recovery state.
