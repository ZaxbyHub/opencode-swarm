# Swarm memory core

## What changed

- Added the Swarm memory core API with scoped memory records, proposals, deterministic IDs, validation, redaction, lexical recall scoring, and prompt-block formatting.
- Added the local JSONL provider under `.swarm/memory/` with append-only memory, proposal, and audit files.
- Added opt-in `swarm_memory_recall` and `swarm_memory_propose` tools. Recall is read-only and proposal writes never create durable memory directly.
- Added memory configuration and documentation for local storage, scopes, kinds, proposal-only writes, and reset/inspection workflows.

## Why

This is the first memory-system PR: it gives agents safe scoped recall and a controlled proposal path without Qdrant, embeddings, mem0, OpenMemory, or raw external MCP tools.

## Migration

No migration is required. Memory is disabled by default; enable it with `memory.enabled: true`.

## Breaking changes

None.

## Known caveats

None for the PR 1 scope. Later memory PRs can build on the shipped gateway and provider API without changing the agent-facing proposal-only contract.
