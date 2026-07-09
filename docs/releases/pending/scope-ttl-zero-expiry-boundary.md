# Scope TTL=0 expiry boundary fix

## What changed
`readScopeFromDisk` (`src/scope/scope-persistence.ts`) now treats a scope as expired when `now >= expiresAt` (previously strict `now > expiresAt`). This corrects the TTL=0 boundary: a scope written with TTL=0 is now immediately expired (returning null), matching the documented semantics. Previously, a same-millisecond write+read could briefly treat a TTL=0 scope as valid.

## Why
The strict `>` boundary caused an intermittent merge-queue flake: `tests/integration/cross-process-scope.test.ts` "TTL of zero is treated as already expired" failed under heavy CI load (merge-group full-suite run) when the write and read landed in the same millisecond. Standard TTL semantics are "valid while `now < expiresAt`, expired when `now >= expiresAt`."

## Impact
Fail-closed: when a disk scope is expired, consumers fall through to plan/pending scope (`resolveScopeWithFallbacks`). The only behavioral change is that TTL=0 scopes (previously valid for a sub-millisecond window) are now correctly expired immediately.
