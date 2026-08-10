# fix(council): persist authoritative council round state

## What changed

- Made task, phase, and final council rounds server-owned and durable under
  `.swarm/council/round-state/`, with an append-only attempt audit under
  `.swarm/council/attempts/` written before every return path.
- Changed caller-supplied `roundNumber` into an optional expectation. Stale and
  future expectations now fail with `council_round_mismatch`; normal callers can
  omit it.
- Removed the producerless member-level round field and its ineffective stale
  verdict checks.
- Added crash recovery around evidence commits, bounded maximum-round behavior,
  strict bounded-tail validation, hashed scope paths, exact-scope locking, and
  parity across task, phase, and final councils.
- Bound final round state to the current plan generation so a changed plan
  cannot reuse stale approval and can be reviewed again without manual cleanup.
- Wired the durable council directory into archive-first `/swarm close` cleanup
  so a later swarm cannot inherit the prior run's closed or advanced rounds.

## Why

Several early returns were not recorded, while accepted round numbers came from
the caller. A retry could therefore skip, replay, or lose the actual council
round, and restarts had no authoritative state from which to recover.

## Migration steps

No user action is required. Council callers should omit `roundNumber` unless
they intentionally want optimistic concurrency checking against a previously
returned `authoritativeRound` or `nextRound`.

## Breaking changes

The unused member-level round field is no longer accepted by council verdict
schemas. Callers that explicitly send `roundNumber` must match the server-owned
current round.

## Known caveats

None.
