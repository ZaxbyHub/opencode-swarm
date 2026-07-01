# Harden final-council gate evidence binding

## What

- Final-council evidence now records both the current plan content hash and a collision-resistant raw plan identity hash.
- The final-council gate now fails closed when the gate is enabled by persisted profile or session override but plan state is unavailable, and it blocks stale or mismatched final-council evidence.
- `.swarm` path validation now rejects symlink escapes for existing path components and symlinked `.swarm` roots.
- `write_final_council_evidence` exposes the same phase upper bound as its executor schema.

## Why

This closes hardening gaps where stale or colliding final-council evidence could satisfy a configured hard gate, or where `.swarm` path validation could rely only on lexical containment.

## Migration

Existing final-council evidence without `plan_hash` and `plan_identity_hash` must be regenerated before completing a final phase with `final_council` enabled.

## Caveats

On hosts without symlink creation privileges, symlink-specific regression tests skip while ordinary containment tests still run.
