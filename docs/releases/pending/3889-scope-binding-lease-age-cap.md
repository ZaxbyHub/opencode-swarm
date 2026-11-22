# Scope-binding admission map now has a 24 h hard age cap

## What

`refreshScopeBindingLease` re-sets a binding's in-memory admission-map entry
with an extended `expiresAt` on every successful in-scope write, and the
sweep only evicted on `expiresAt` — so a continuously renewed binding never
expired. The map (module-global, 256-entry capacity) can therefore grow to
capacity in a long-lived plugin process, after which every admission fails
with `SCOPE_BINDING_CAPACITY` on `declare_scope` (the coder-write
resolution path renders the same failure as `SCOPE_BINDING_STORE_OVERLOADED`).
A wedge was observed 2026-11-20 with a `/swarm reset-session` that did not
clear it, but map saturation is not shown to be its cause; this change is
defensive hardening for the in-memory map, and issue #3889 stays open.

The sweep now also evicts entries whose ORIGINAL declaration is older than
24 hours (`MAX_SCOPE_BINDING_AGE_MS`), regardless of lease renewal. The
durable store and its tombstone pruning are unchanged.

## Why

The cap bounds a process-lifetime leak without touching the durable
authority or the 1 h nominal TTL. Documented trade-off: a binding is evicted
at the cap EVEN WHILE its lease is renewed, so a coder session continuously
writing into one declared scope for over 24 hours loses its in-memory
admission; writes may then be denied intermittently (idle revival can
re-authorize after a lease lapse, so the cap does not bound authority
lifetime). The remedy for a denial is a fresh `declare_scope`
(`replace_existing=true`) followed by a new Task dispatch; the denial text
reads `SCOPE_BINDING_EXPIRED ... expired while idle`, which is misleading for
an actively writing coder. 24 h is 24x the nominal TTL and far above the 30 min
lane-liveness watchdog, so no realistic single dispatch reaches the cap.

## Known caveats

- A pre-existing sweep behaviour (tombstone writes can overwrite a
  deliberate revocation tombstone) is unchanged in kind; this cap adds one more
  write class to that path.
- A pre-existing diagnostic gap remains: any durable read failure on the
  admission path also surfaces as `SCOPE_BINDING_STORE_OVERLOADED`; this is
  pre-existing and unchanged by this PR.

Regression-tested in `tests/unit/scope/scope-binding-lease-age-cap.test.ts`
(includes the real `refreshScopeBindingLease` renewal path, the 24 h
boundary, and the tombstone shape). Refs #3889.
