# Architecture Supervision — Propose-only Knowledge Feedback (Chunk E)

## What changed

- **`curateAndStoreSwarm` gains a `skipAutoPromotion` option**
  (`src/hooks/knowledge-curator.ts`): callers that only want to PROPOSE candidate
  knowledge can now skip the post-write auto-promotion pass, so proposing one lesson no
  longer promotes unrelated pre-existing candidates as a side effect.

- **`write_architecture_supervisor_evidence` routes recommendations to knowledge**
  (`src/tools/write-architecture-supervisor-evidence.ts`): when
  `architectural_supervision.persist_knowledge_recommendations` is true, the supervisor's
  `knowledge_recommendations` are stored as `status:'candidate'` swarm knowledge (deduped,
  capped, never auto-promoted). Best-effort — knowledge feedback never fails the evidence
  write. Disabled by default.

## Why

Final step of issue #893's "optimizer" loop: durable lessons the supervisor surfaces feed
back into future runs as proposals, without auto-activating anything.

## How to use

Set `architectural_supervision.persist_knowledge_recommendations: true`. Proposed lessons
land as candidate knowledge for normal review/promotion; nothing is auto-promoted or
auto-activated.

## Migration

No migration required; feature is opt-in and off by default.

## Known caveats

- Knowledge recommendations are stored as candidates only. Skill-draft generation from
  repeated-failure-loop findings is not wired in this chunk.

Refs: #893
