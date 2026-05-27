# Architecture Supervisor — Critic Role (Chunk C)

## What changed

- **New `critic_architecture_supervisor` role** (`src/agents/critic.ts`): a fifth
  `CriticRole` that reviews the COMPRESSED per-phase summaries (not code/diffs) to catch
  cross-task contradictions, constraint/doc drift, repeated failure loops, scope creep,
  risky assumptions, and knowledge gaps. Read-only; emits a strict-JSON verdict
  (`APPROVE | CONCERNS | REJECT`). It inherits the `critic` model unless you override
  `agents.critic_architecture_supervisor.model`, so power users can route this one role
  to a stronger model for the cheap-workers → expensive-supervisor pattern.

- **New `write_architecture_supervisor_evidence` tool**
  (`src/tools/write-architecture-supervisor-evidence.ts`): the architect dispatches the
  supervisor, collects its JSON verdict, then calls this tool to persist
  `.swarm/evidence/{phase}/architecture-supervisor.json` as a raw sidecar (the shape the
  phase-complete gate reads in a later chunk). Persists only — it does not contact the
  supervisor, mirroring `submit_phase_council_verdicts`.

- **Registration**: agent added to `ALL_SUBAGENT_NAMES`, `AGENT_TOOL_MAP` (read-only
  summary tools), `MEMORY_AGENT_TOOL_MAP`, `DEFAULT_MODELS`, `DEFAULT_AGENT_CONFIGS`, and
  the `createAgents` factory; tool registered across `TOOL_NAMES`, the plugin tool block,
  and the architect tool map.

## Why

Third step of issue #893: an expensive, read-only supervisor that reviews summaries
(not code) for system-level incoherence — the gap that no per-task reviewer fills.

## How to use

Enable `architectural_supervision` and dispatch `critic_architecture_supervisor` at phase
completion with the aggregated phase summary + agent summaries, then persist the verdict
with `write_architecture_supervisor_evidence`. Advisory in this chunk (never blocks); the
opt-in phase-complete gate arrives next.

## Migration

No migration required.

Refs: #893
