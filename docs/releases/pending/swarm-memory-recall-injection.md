# Swarm memory recall injection

## What changed

- Added opt-in automatic memory recall injection for agent calls when `memory.enabled` is true.
- Added role-specific recall profiles, explicit controller-derived recall scopes, optional provider-level recall usage recording, and per-run memory logs under `.swarm/runs/<run-id>/memory.jsonl`.
- Added Task output `memoryProposals` capture through `MemoryGateway.propose`, preserving proposal-only writes.
- Memory tools (`swarm_memory_recall`, `swarm_memory_propose`) are conditionally added to agent tool sets only when `memory.enabled` is true; they do not appear in default agent configurations.

## Why

Memory becomes useful only when agents receive relevant scoped facts at the point of work. The injection path stays behind the gateway/provider seam so future JSONL to SQLite or Qdrant storage changes do not alter agent behavior. Tools are opt-in to avoid polluting agent prompts and tool lists when memory is not enabled.

## Migration

No migration is required. Memory remains disabled by default, and custom memory providers can opt into `recordRecallUsage` without implementing it immediately.

## Breaking changes

None.

## Known caveats

No curator approval loop, Qdrant, embeddings, or storage migration is included in this PR.
