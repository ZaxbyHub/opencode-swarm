# Context Map and Context Capsules

## What changed

Adds an opt-in Context Map and Context Capsules feature (`context_map.enabled`) that reduces repeated agent context rediscovery across multi-agent handoffs in opencode-swarm.

### New modules
- **Data model** (`src/types/context-map.ts`, `src/types/context-capsule.ts`): Core types for `ContextMap`, `FileContextEntry`, `TaskContextSummary`, `DecisionEntry`, `ContextCapsule`, `CapsuleDelegationReason`, `AgentRole`, `ReadPolicyEntry`, `RoleProfile`, and `CapsuleMetadata`.
- **Config schema** (`src/config/schema.ts`): `ContextMapConfigSchema` with `enabled`, `mode` (conservative/balanced/aggressive), `max_capsule_tokens`, `invalidate_on_hash_change`, and `agent_profiles` fields.
- **Persistence** (`src/context-map/persistence.ts`): Atomic read/write with SHA-256 content hashing, stale detection, append operations, and `_internals` DI seam.
- **File summary** (`src/context-map/file-summary.ts`): Language detection, export/import extraction, and batch population.
- **Capsule builder** (`src/context-map/capsule-builder.ts`): Role-specific profiles, read policy generation, capsule markdown formatting, and token budget pruning. Config fields (`mode`, `agent_profiles`, `invalidate_on_hash_change`) are consumed at runtime.
- **Capsule persistence** (`src/context-map/capsule-persistence.ts`): Save/load/delete/list capsules at `.swarm/capsules/{taskId}.json` with atomic writes.
- **Post-agent update** (`src/context-map/post-agent-update.ts`): Updates the context map after agent task completion — refreshes file summaries, appends task history, extracts evidence findings, records decisions. Wired into `tool.execute.after` when `context_map.enabled === true`.
- **Telemetry** (`src/context-map/telemetry.ts`): JSONL recording/reading, structural validation (`isValidTelemetryEntry`), and summary aggregation.
- **Injection hook** (`src/hooks/context-capsule-inject.ts`): System message transform hook that injects role-specific capsules into delegated agent sessions. Extracts delegation reason from `taskWorkflowStates` (not `lastDelegationReason`), task goal from `plan.json`, and persists capsules via `saveCapsule`.
- **Documentation** (`docs/context-map.md`): 191-line feature documentation covering architecture, configuration, and usage.

### Wiring
- Hook registered in `src/index.ts` system.transform chain and `tool.execute.after` for post-agent updates.
- Capsules persisted to `.swarm/capsules/` on every delegation.
- Post-agent update runs automatically when Task tool completes.

## Why

Agents in multi-agent swarms spend significant context budget re-reading files they've already seen. Context Capsules provide focused, pre-summarized context so agents can begin work immediately without redundant file reads.

## Migration steps

Enable the feature in your opencode config:

```json
{
  "context_map": {
    "enabled": true,
    "mode": "balanced",
    "max_capsule_tokens": 2000
  }
}
```

No migration needed — feature is off by default.

## Breaking changes

None. The feature is entirely opt-in and disabled by default.

## Known caveats

- `files_touched` in post-agent update is empty — the wiring passes `[]` and relies on `extractEvidenceFindings` for actual file data.
- `batchPopulateSummaries` in `file-summary.ts` is exported but not called from production code (reserved for future bulk pre-scan).
- `implementation_summary` is truncated to 500 chars from agent output.
- `task_goal` is read from `plan.json` synchronously (acceptable latency for the hook path).
