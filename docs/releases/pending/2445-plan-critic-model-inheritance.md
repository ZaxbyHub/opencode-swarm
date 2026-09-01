# Plan-critic model inheritance parity

## Fixed

- Plan-critic dispatch preflight now validates the same effective model as runtime Task routing, including inherited `critic` models, explicit critic-variant overrides, and named-swarm overrides. This prevents valid critic dispatches from being blocked because preflight checked an unused default model.
- Unresolved-model diagnostics now identify the exact generated critic target and its effective configuration, so named-swarm users are no longer directed to a top-level key that may not control the target.

## Migration

No configuration changes are required.

## Breaking changes

None.

## Known caveats

None.
