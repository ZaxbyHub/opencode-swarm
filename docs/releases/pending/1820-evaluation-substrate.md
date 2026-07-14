# Bounded evaluation substrate and production gate audit

## What changed

- Added versioned, content-addressed task, run, promotion, gate-audit, and held-out test-consumption contracts under `.swarm/evolution/`.
- Added isolated baseline/candidate execution with deterministic paired-bootstrap promotion statistics, protected-category checks, historical-best comparison, explicit budgets, retries, cancellation, honest unavailable-data handling, and a stable package-level `evaluationV1` API.
- Shipped a packed 12-defect Tier-1 corpus with green baselines plus `/swarm gate-audit` and `/swarm gate-stats` for exact-join defect/clean-control measurement across reviewer, test-engineer, offline SAST, real bounded mutation patches, quality, and reviewer-fallback paths.
- Added optional `/swarm benchmark --ci-gate --gate-audit-run <id>` consumption of authoritative run-scoped exact joins, production test-impact classification from real bounded baseline/defect output, truthful generic-run and nested-audit retention, bounded mutation subprocess execution, and typed reviewer-gate telemetry.
- Task and candidate input hashing now uses asynchronous, aggregate-budgeted filesystem traversal, and best-effort model-session cleanup emits debug diagnostics on rejection or timeout without blocking evaluation completion.

## Why

Swarm improvements need repeatable evidence that candidate behavior and production gates improve without overfitting, contaminating held-out tasks, mutating the active checkout, or treating missing measurements as successful zeros.

## Migration

No migration is required. Existing evidence and benchmark commands remain compatible; gate-audit storage is created only when the new command runs.

## Breaking changes

None.
