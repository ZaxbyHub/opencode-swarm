# Architecture Summaries — Phase Aggregation (Chunk B)

## What changed

- **Phase-level summary aggregation** (`src/summaries/aggregate.ts`): a cheap,
  deterministic rollup that reads all per-agent `summarize_work` summaries for a
  completed phase, unions their decisions/risks/constraint-violations, and surfaces
  cross-agent contradictions (a constraint one agent observed but another violated).
  The result is written as a `phase-architecture-summary.json` sidecar.

- **Phase-monitor trigger** (`src/hooks/phase-monitor.ts`): on a phase boundary the
  monitor runs the aggregation for the just-completed phase, gated on
  `architectural_supervision.enabled` and fully isolated/best-effort so it can never
  disrupt preflight.

- **New config block** (`src/config/schema.ts`): `architectural_supervision`
  (opt-in, default disabled; advisory mode; word caps; gate/feedback toggles for later
  chunks).

## Why

Second step of issue #893: roll task-level summaries up to a phase view so the
architecture-supervisor critic (a later chunk) can review cross-task coherence cheaply.

## How to use

Set `architectural_supervision.enabled: true` in `.opencode/opencode-swarm.json`.
Aggregation then runs automatically at phase boundaries; the supervisor review and gate
arrive in follow-up chunks.

## Migration

No migration required; feature is opt-in and off by default.

## Known caveats

- Aggregation is deterministic (no LLM compression yet) and does not block.

Refs: #893
