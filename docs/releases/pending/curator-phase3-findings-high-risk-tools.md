# Curator Phase 3 — findings persistence, dual-invocation fix, configurable HIGH_RISK_TOOLS

## Overview

Phase 3 completes the curator and knowledge-application hardening from Phase 1–2, adding findings persistence, fixing a dual-invocation bug, making the high-risk tools list configurable, and upgrading drift detection to use spec-based FR coverage analysis.

## Changes

### Curator findings persistence

`runCuratorPhase` in `src/hooks/curator.ts` now writes structured knowledge-application findings returned by the curator LLM to `.swarm/evidence/{phase}/curator-findings.json` when the curator emits `knowledge_application_findings` blocks. The file is written atomically (tmp+rename) only when findings are present. Previously these findings were held in memory only and lost after the phase.

### Dual-invocation fix

`runCuratorPhase` now guards against re-digesting the same phase. When `priorSummary.phase_digests` already contains an entry for the target phase, the function returns immediately with `already_digested: true` and `summary_updated: false`, skipping all analysis and write paths. This prevents duplicate digest entries, compliance event duplication, and ephemeral-session leaks when `phase_complete` or `curator_analyze` is called multiple times for the same phase.

The `CuratorPhaseResult` type gains an optional `already_digested: boolean` field (absent when false/undefined, for backward compatibility with callers that spread the result).

### Conditional curator_analyze advisory

`curator_analyze` tool no longer emits an advisory message to the architect when `already_digested: true` — the phase has already been analyzed and the prior digest is returned unchanged. When `already_digested: false`, the advisory is emitted as before.

### Missing sessionID warning event

`knowledgeApplicationGateBefore` in `src/hooks/knowledge-application-gate.ts` now emits a `knowledge_application_gate_warn` event to `events.jsonl` when a high-risk tool fires but `sessionID` is missing from the gate input (warn mode only; enforce mode still throws). The event includes `tool`, `agent`, `reason: 'missing_sessionID'`, and `mode`. Previously warn mode silently proceeded with no diagnostic trace for this contract violation.

### Configurable HIGH_RISK_TOOLS

`KnowledgeApplicationConfig` in `src/hooks/knowledge-application.ts` and the corresponding `KnowledgeApplicationConfigSchema` in `src/config/schema.ts` now accept an optional `high_risk_tools: string[]` field. When present, it overrides the hardcoded default set `['save_plan', 'update_task_status', 'phase_complete', 'task', 'Task']`. This lets operators narrow or expand the set of tools that trigger knowledge-directive acknowledgment without patching source code.

Default in the schema:

```jsonc
"high_risk_tools": ["save_plan", "update_task_status", "phase_complete", "task", "Task"]
```

### Spec-based drift detection with FR coverage analysis

`runDeterministicDriftCheck` in `src/hooks/curator-drift.ts` now extracts FR-### requirement IDs from `spec.md`, `plan.md`, and the curator digest, then computes a spec coverage ratio. Drift alignment is determined by:

1. **Spec coverage** — less than half of spec requirements appear in plan → `MAJOR_DRIFT`
2. **Compliance severity** — 3+ serious warnings → `MAJOR_DRIFT` (takes priority over coverage)
3. **Minor concerns** — 1+ warning or 3+ compliance issues → `MINOR_DRIFT`
4. **Implementation gap** — plan covers requirements but digest doesn't reference them → `MINOR_DRIFT`

When no spec exists, falls back to the previous compliance-count scoring.

The drift report's `injection_summary` field now includes a coverage note like `[3/12 FRs covered]` when spec requirements are present.

## Migration steps

None required. All changes are backward-compatible:

- `already_digested` is optional on `CuratorPhaseResult`; callers that don't check it see no behavioral change.
- `high_risk_tools` defaults to the prior hardcoded set when absent from config.
- Missing sessionID path only fires in warn mode and only when the OpenCode contract is violated — normal operation is unaffected.

## Invariant audit

- §5 Plan durability: curator findings written to `.swarm/evidence/{phase}/curator-findings.json` — new path under `.swarm/`, atomic tmp+rename, no plan mutations.
- §7 Test writing: all changes use `bun:test`; no `mock.module`; DI seams (`_internals`) used for testability.
- §9 Guardrails / retry semantics: warn mode emits `knowledge_application_gate_warn` event; enforce mode throws — no silent bypass.
- §10 Chat / system-message hook contracts: `knowledgeApplicationTransformScan` unchanged; `knowledgeApplicationGateBefore` only adds a diagnostic event, does not modify message shape.
