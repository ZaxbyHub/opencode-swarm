## fix(final-council): port PR #1244 hardening onto latest main

Ports the intended hardening changes from PR #1244 onto a fresh branch from origin/main, adapted to current main's resolveGatePreamble structure.

### Changes

- **Symlink hardening** (src/hooks/utils.ts): Added s.realpathSync containment to alidateSwarmPath to reject symlinks that escape .swarm/. Preserves normal non-symlink write paths and nonexistent target behavior via ENOENT fallback to parent directory.
- **Timestamp freshness** (src/tools/phase-complete/gates/final-council-gate.ts): Added 24h staleness warning and future-timestamp blocking check, mirroring rchitecture-supervisor-gate.ts pattern.
- **Plan-missing handling**: Gate fails-open with warning when plan.json is missing. Writer returns early with plan_not_found error.
- **Turbo bypass fix** (src/tools/phase-complete.ts): Removed turbo bypass for Gate 6 (Final Council) to match the NOT turbo-bypassed comment. Updated turbo skip warning to remove final-council from skipped list.
- **Schema validation** (src/tools/write-final-council-evidence.ts): Added .max(1000) to phase field in ArgsSchema.
- **Tool metadata** (src/tools/tool-metadata.ts): Expanded write_final_council_evidence description to match peer entries.

### Tests

- Symlink regression: rejects escape, allows internal, preserves normal, handles nonexistent
- Stale timestamp (>24h) emits warning
- Plan-missing fail-open returns blocked:false with warning
- Plan-missing early return returns success:false with plan_not_found
- phase > 1000 rejected by Zod schema
- Turbo test updated: Gate 6 always runs, not turbo-bypassed

### Scope reductions vs PR #1244

- No derivePlanId V1/V2 migration (15+ caller blast radius too high for a port)
# CI trigger 2026-06-15T15:07:03.4196089-05:00

<!-- CI trigger -->
