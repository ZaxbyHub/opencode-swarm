# Ownerless plan lock recovery

## What

`tryAcquireLock` now recovers an empty or invalid-JSON `.lck` file once it is
past the lock TTL, matching the recovery behavior already shipped for the
evidence and events stores. Previously such a lock wedged every plan writer
(including `/swarm reset`) until a human deleted the file.

## Why

A torn or empty `.lck` artifact (crash mid-write, truncated write, legacy
ownerless artifact) carries no owner pid, so the `dead-owner` breaker class
returned `unknown` and the acquire path never broke it. The only recovery route
was `cleanupExpiredLocks`, which has no production caller. Plan writers that
use `tryAcquireLock` directly (not via a wrapper with its own contention-loop
break) were permanently wedged.

## Migration

No breaking changes. The fix adds a `ttl-cleanup` branch to the contention path
for ownerless payloads; fresh (within-TTL) ownerless locks still time out as
before.
