# Curator hook enrichment wiring, batching, and quota isolation

## What changed

- Updated curator lesson enrichment to batch plain-prose lessons into grouped LLM
  requests (batch size 6) instead of one request per lesson.
- Added batch JSON-array parsing/validation with per-item actionability checks and
  bounded retry behavior.
- Kept hook-triggered curation paths wired to the session-scoped curator delegate
  and dedicated `knowledge.enrichment` quota options.
- Updated integration coverage to assert:
  - quota exhaustion uses `knowledge-enrichment-quota.json`
  - enrichment batching stores 12 lessons in 2 enrichment calls
  - skill improver quota state is untouched by curator enrichment.
  - retry is batch-level: the whole batch is retried, not individual items.

## Why

Hook-driven retrospective ingestion could consume too many enrichment calls for
large retros and was validated against stale quota assumptions. Batching reduces
call volume while preserving the Layer-5 actionability gate and separate quota
scope behavior.

## Impact

- Large retrospective batches now consume substantially fewer enrichment calls.
- Curator enrichment remains isolated from skill improver quota state.
- Each enrichment attempt — including retries — counts against the knowledge-enrichment quota.
- Queue behavior and actionability quarantine semantics remain unchanged.

## Migration

No migration required.

## Breaking changes

None.
