# Hierarchical Architecture Summaries — Foundation (`summarize_work`)

## What changed

- **New `summarize_work` tool** (`src/tools/summarize-work.ts`): agents call this
  once at task completion to emit a short structured summary of what they did —
  one-paragraph summary plus key decisions, assumptions, risks, and constraints
  observed/violated. Summaries are capped (≤100 words, ≤5 items per list) by
  truncation, never rejection, and the tool is advisory (it never blocks).

- **Summary storage module** (`src/summaries/schema.ts`, `src/summaries/store.ts`):
  per-agent summaries are persisted as `note` evidence entries (structured payload
  under `metadata`); per-phase summaries and the architecture-supervisor report are
  written as raw atomic sidecars under `.swarm/evidence/{phase}/`, mirroring the
  phase-council writer so the gate can read top-level fields without schema stripping.

- **Tool registration**: added `summarize_work` to `TOOL_NAMES`, the plugin tool
  block, and `AGENT_TOOL_MAP` for the implementation agents (architect, explorer,
  coder, test_engineer, sme, reviewer, designer, docs).

## Why

First step of issue #893 (architectural supervisor / hierarchical summary review):
cheap worker agents emit short summaries that roll up task → phase → project so an
expensive read-only supervisor can later catch cross-task contradictions, drift, and
repeated failure loops that no per-task reviewer sees.

## How to use

Agents that perform implementation work can call `summarize_work` at task completion.
No configuration is required; storage and aggregation are inert until later chunks
wire up the rollup and supervisor.

## Migration

No migration required.

## Known caveats

- Summaries are advisory only in this chunk — nothing consumes them yet (phase
  aggregation and the supervisor critic land in follow-up chunks).

Refs: #893
