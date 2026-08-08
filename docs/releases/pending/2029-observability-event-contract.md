# Canonical observability event contract

## What

Introduces `src/observability/`: a canonical, zod-typed observability event
envelope, a 39-entry catalog of every event kind the codebase currently emits,
a relationship-validation function, a legacy-payload adapter, deterministic
sampling and bounded-cardinality helpers, and a versioned OTel/OpenInference
attribute-mapping table. Wires the envelope into the one live production event
stream that already exists (`src/telemetry.ts:emit()`) and fixes one concrete
type-system bypass: `agent_conflict_detected` was previously emitted via a
force-cast past `TelemetryEvent` (`src/hooks/conflict-resolution.ts:67-70`);
it is now a typed, catalogued event kind.

This is internal/additive. It defines a contract and closes one bug; it does
not add a new destination for observability data.

## Before

- No shared definition of what an observation is. Every producer (telemetry,
  context-map telemetry, skill-usage log, events.jsonl, knowledge events,
  trajectory logs, background delegations, guardrail audit, council evidence,
  archive, plus three SQLite memory tables and the PR-monitor subscription
  log — sixteen stores in total) independently invented its own record shape,
  discriminator key, clock representation, and correlation-ID set.
- `.swarm/events.jsonl` was written under two different discriminator keys
  within a single file (`src/context/role-filter.ts:147` uses `event:`, `src/hooks/curator.ts:1755`
  uses `type:`).
- `agent_conflict_detected` reached production through a force-cast that
  defeated the `TelemetryEvent` type check; it was invisible to any type-level
  or catalog-level audit.
- `.swarm/telemetry.jsonl` was written as an untyped inline object literal
  (`{ timestamp, event, ...data }`) with no envelope, no catalog, and no
  contract test asserting its shape.

## After

- `src/observability/` exists, exporting a canonical envelope, a 39-entry
  catalog (`EVENT_CATALOG`), relationship validation, a legacy adapter,
  sampling/cardinality helpers, and OTel/OpenInference mapping tables — fully
  documented in `docs/observability-event-contract.md`.
- `src/telemetry.ts:emit()` builds a canonical `ObservabilityEvent` in memory
  and derives the written `.swarm/telemetry.jsonl` line from it as an
  explicitly documented lossy projection. **The user-visible output is
  byte-identical to before this change** (one documented exception: payloads carrying an own accessor property, which no call site uses — see `docs/engineering-invariants.md`) — verified against a checked-in
  golden corpus captured from the real `emit()` function on the unmodified
  tree. There is no new file, no new destination, and no behavior change any
  user of `/swarm costs`, `/swarm status`, or the raw telemetry file will
  observe.
- `agent_conflict_detected` is a plain typed `emit(...)` call; the force-cast
  is deleted.
- A new blocking CI check (`bun run check:events`) fails a PR that adds an
  event kind, a catalog entry, or a metric label outside the contract's
  rules — the same class of registry-completeness gate
  `check-tool-registration.ts` already enforces for tools.
- **Be honest about scope:** the envelope's richer fields (event id, trace
  context, lineage, provenance, policy, relationship-violation codes) are
  constructed but currently **discarded** after the legacy line is written.
  Nothing in this PR consumes them yet — their consumer is a later PR in this
  sequence (#2047). This PR is the contract and the catalog, not the sink.

## Migration

No action required. No config keys, file paths, CLI flags, or output formats
changed. This PR is purely additive at the module level and internally
substitutive at the one production call site it touches
(`src/telemetry.ts:emit()`), with byte-identical output guaranteed by a
golden-corpus test.

## Related

- Closes part of #2029 (Observability event contract). PR 01 of 23 in the
  observability sequence (#2029–#2051).
- `docs/observability-event-contract.md` — the full contract reference,
  including the 39-entry catalog and the 16-row producer/consumer matrix.
- `docs/engineering-invariants.md` — the invariant entry for issue #2029.
