# Architecture Supervision — Architect Orchestration + Skill-draft Feedback

## What changed

- **Architect prompt now drives the supervisor** (`src/agents/architect.ts`): when
  `architectural_supervision.enabled`, a conditionally-injected workflow block instructs
  the architect to (1) remind workers to call `summarize_work` at task completion, and
  (2) at phase end dispatch `critic_architecture_supervisor` over the summaries, collect
  its JSON verdict, and persist it via `write_architecture_supervisor_evidence`. Gate vs
  advisory phrasing reflects the configured mode. The block collapses to nothing when the
  feature is disabled (byte-for-byte non-regression), mirroring the council-workflow
  injection pattern.

- **Skill-draft feedback** (`src/tools/write-architecture-supervisor-evidence.ts`): when
  feedback is enabled and the supervisor reports a `failure_loop` finding, the tool runs a
  best-effort DRAFT skill-generation pass (proposals only, never active). No-ops when no
  mature knowledge cluster exists.

## Why

Completes issue #893's loop: the orchestrator now actually runs the supervisor and feeds
durable lessons / skill drafts back into future runs, rather than leaving the machinery
unwired.

## How to use

Enable `architectural_supervision`; the architect's workflow now includes the supervisor
step automatically. Set `persist_knowledge_recommendations: true` to also propose
candidate knowledge and draft skills from failure-loop findings.

## Migration

No migration required; all behavior is gated on the opt-in feature flag.

Refs: #893
