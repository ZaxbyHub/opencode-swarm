# Scope bindings no longer wedge the swarm after long plugin sessions

## What

The in-memory scope-binding admission map now evicts entries whose original
declaration is older than 24 hours (`MAX_SCOPE_BINDING_AGE_MS`), in addition to
the existing expiry sweep. Previously, every successful in-scope write renewed
a binding's lease (extending its `expiresAt` by another hour), so a binding
that kept being renewed never expired. On a long-lived plugin process with
heavy multi-project swarm use, the map eventually reached its 256-entry
capacity, after which **every** `declare_scope` / coder write was denied with
`SCOPE_BINDING_STORE_OVERLOADED` until the plugin process was restarted.

## Why

A binding that old cannot correlate to a live dispatch anyway (the nominal
binding TTL is 1 hour and the lane-liveness watchdog is 30 minutes), so
evicting it changes no live behaviour — it only stops the wedge. Once the cap
is in place, a wedged process self-heals on the next `declare_scope` call
instead of requiring a restart. Regression-tested in
`tests/unit/scope/scope-binding-lease-age-cap.test.ts` (issue #3889).
