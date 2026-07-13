# PR review Phase 4 and regression-sweep repair

## What changed

- Made deep PR review Phase 4 auditable and non-skippable with exact trigger-map
  accounting, durable trigger evidence, provenance-based micro-lane acceptance,
  and a reviewer join barrier.
- Reconciled candidate producer/parser contracts with asserted row families,
  marker compatibility, and durable CLEAN attestations for verified negative
  micro-lane results.
- Changed execute regression sweeps to run once per changed source file so
  multi-file tasks no longer silently skip graph-based regression coverage.

## Why

Valid micro-lane findings could be field-shifted and discarded, clean lanes
could never finish, and ordinary multi-file execution tasks skipped their graph
regression sweep because orchestration contradicted the runtime safety cap.

## Migration

No user configuration changes are required. Custom candidate producers should
emit the marker-bearing header once, use unprefixed data rows, and emit the
documented `[CLEAN]` sentinel for a clean micro-lane.
