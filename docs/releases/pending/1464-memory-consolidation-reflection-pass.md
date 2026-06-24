# Issue #1464: Memory consolidation reflection pass (Phase 3)

## Overview

Swarm memory now "thinks about" its accumulated episodic events. A new
reflection/consolidation loop distills raw episodic proposals into durable
semantic facts at phase boundaries, deduplicates, supersedes contradictions,
decays stale memories by kind, and replaces the old boolean low-utility
heuristic with a continuous importance score. Everything is gated by
`memory.enabled` and `memory.consolidation.enabled` (both opt-in via the
memory feature flag), so existing users are unaffected.

## What's new

- **`curator_consolidation` agent.** A read-only curator role that distills
  clusters of episodic memory into durable semantic facts and flags
  contradictions. Registered like its sibling curators (name registry, tool
  map, default/fallback models, multi-swarm prefixing, LLM delegate).
- **Consolidation engine (`src/memory/consolidation.ts`).** At
  `phase_complete`, a fire-and-forget pass (`src/services/memory-consolidation.ts`,
  mirroring the skill-consolidation precedent) clusters pending proposals by
  Jaccard token overlap, asks the curator to distill durable facts, and routes
  each candidate through the existing `propose → applyCuratorDecision`
  pipeline:
  - durable, ≤500-char, high-confidence facts are auto-applied (`add`);
  - contradictions become `supersede` decisions (never silent overwrites);
  - near-duplicates are skipped;
  - low-confidence / non-durable / oversized facts are filed as pending
    proposals for review, never auto-applied.
  The pass is idempotent per phase and cost-capped (`maxClustersPerPass`).
- **Importance formula (DD-11).** `isLowUtility`'s ambiguous `||` heuristic is
  replaced by a continuous `importanceScore` (recency, frequency, freshness,
  confidence). A high-confidence, never-recalled, aged memory is no longer
  mislabeled low-utility.
- **Kind-specific decay.** Each consolidation pass applies kind-specific decay
  half-lives via `expiresAt` (e.g. `todo` 30d, patterns 90d, evidence 180d;
  durable architecture/convention/project facts never auto-expire). Decay
  preserves `id`/`createdAt`/`updatedAt` and never shortens an earlier expiry.
- **Sentinel hardening (DD-14).** Stored memory text can no longer contain the
  `## Retrieved Swarm Memory` recall sentinel; it is rejected at write time in
  `validateMemoryRecordRules` (the single choke point for all write paths), and
  the emitter and guard now share one constant (`src/memory/sentinel.ts`).
- **Observability + CLI.** Six new run-log events
  (`consolidation_started`, `cluster_count`, `decisions_emitted`,
  `contradictions_detected`, `memories_decayed`, `consolidation_completed`)
  and `/swarm memory consolidation-log` to review recent passes and metrics.

## Configuration

New `memory.consolidation` block (`enabled`, `maxClustersPerPass`,
`jaccardThreshold`, `autoApplyMinConfidence`, per-kind `decayHalfLifeDays`) and
`memory.maintenance.importance` (formula weights + low-utility threshold), both
with defaults in the zod schema and the runtime config. Deprecated
`maintenance.lowUtility{MaxConfidence,MinAgeDays}` fields are retained for
back-compat.

## Notes / deviations

- Idempotency and observability state live in
  `.swarm/memory/consolidation-log.jsonl` (no SQLite schema migration); run-log
  events are still emitted per the spec.
- Embedding-based clustering remains out of scope (Phase 4); v1 uses lexical
  Jaccard clustering.
