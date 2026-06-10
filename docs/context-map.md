# Context Map and Context Capsules

> Feature introduced in v7.4.0 — opt-in only (disabled by default)

## Overview

Context Map and Context Capsules reduce repeated agent context rediscovery across multi-agent handoffs in opencode-swarm. When an architect delegates to a subagent (coder, reviewer, critic, test_engineer, or sme), a **context capsule** is injected into the agent's system message providing file summaries, read policies, and task context.

Without this feature, each delegated agent must re-read source files to understand the codebase. Context Capsules reduce this rediscovery when the project's Context Map has already been populated with current file summaries, providing agents with cached summaries derived from the Context Map.

The Context Map is a durable snapshot of file-level summaries, task history, and architectural decisions. It lives at `.swarm/context-map.json` and is read during capsule building (falling back to an empty map when the file is absent). A post-agent write-back module automatically updates the map via the `tool.execute.after` lifecycle hook after agent task completion when `context_map.enabled === true`.

## Configuration

The feature is **opt-in** — it must be explicitly enabled in your opencode configuration.

```json
{
  "context_map": {
    "enabled": true,
    "mode": "balanced",
    "max_capsule_tokens": 2000,
    "invalidate_on_hash_change": true,
    "agent_profiles": {}
  }
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable the feature. **Must be `true`** for any capsule injection to occur. |
| `mode` | `"conservative"` \| `"balanced"` \| `"aggressive"` | `"balanced"` | Controls capsule detail density: `conservative` includes more files (1.5× max_files), `balanced` uses defaults, `aggressive` includes fewer files (0.6× max_files). |
| `max_capsule_tokens` | `number` (positive integer) | `2000` | Token budget per capsule. Capsules exceeding this are pruned. |
| `invalidate_on_hash_change` | `boolean` | `true` | Controls whether SHA-256 hash comparison is used to detect stale file summaries. When `false`, cached summaries are always trusted without re-hashing. |
| `agent_profiles` | `Record<string, string>` | `{}` | Allows overriding the built-in read strategy for specific agent roles (e.g., `{ "reviewer": "thorough" }`). |

> **Note:** The `mode`, `invalidate_on_hash_change`, and `agent_profiles` fields are consumed at runtime by the capsule builder (`capsule-builder.ts`) and the capsule injection hook (`context-capsule-inject.ts`). They affect capsule construction and read policy behavior.

## Architecture Overview

The feature is implemented across several modules:

| Module | Purpose |
|--------|---------|
| **Types** (`src/types/context-map.ts`, `src/types/context-capsule.ts`) | TypeScript interfaces for `ContextMap`, `FileContextEntry`, `TaskContextSummary`, `DecisionEntry`, and `ContextCapsule` |
| **Persistence** (`src/context-map/persistence.ts`) | Atomic read/write for `.swarm/context-map.json` with SHA-256 content hashing for invalidation |
| **File Summary** (`src/context-map/file-summary.ts`) | Language detection, export/import extraction, purpose summarization from JSDoc comments |
| **Capsule Builder** (`src/context-map/capsule-builder.ts`) | Role-specific capsule construction with per-file read policies |
| **Capsule Persistence** (`src/context-map/capsule-persistence.ts`) | Capsule CRUD at `.swarm/capsules/{task_id}.json` |
| **Post-Agent Update** (`src/context-map/post-agent-update.ts`) | Write-back helper for updating the Context Map after agent completion; wired into the `tool.execute.after` lifecycle hook when `context_map.enabled === true` |
| **Telemetry** (`src/context-map/telemetry.ts`) | JSONL telemetry recording at `.swarm/context-telemetry.jsonl` |
| **Hook** (`src/hooks/context-capsule-inject.ts`) | System message injection via the `experimental.chat.system.transform` hook |

## Capsule Contents Per Role

Each agent role receives a capsule tailored to its responsibilities. The capsule is injected as a structured markdown document appended to the agent's system message.

> **Note:** The capsule builder supports all fields listed below. The currently wired automatic hook passes `task_goal` as empty and uses `delegation_reason: 'new_task'`. Optional fields (prior rejection, required fix, review checklist, coverage targets, relevant facts) are available when the builder is invoked with those parameters.

### Coder

- File summaries for the task's scoped files (up to 15)
- Task goal description
- Read policy (which summaries to trust vs. which files to read directly)
- Prior rejection context (if this is a fix iteration after reviewer rejection)
- Required fix description (if applicable)

### Reviewer

- File summaries for the task's scoped files (up to 20)
- Task goal description
- Read policy
- Review checklist (items to verify)
- Coverage targets (if available)
- Prior rejection context (if a fix is being re-reviewed)

### Critic

- High-level architecture overview (up to 5 files)
- Task goal description
- Read policy
- Decisions log relevant to the task scope
- No per-file details — critics operate at the design level

### Test Engineer

- File summaries for the task's scoped files (up to 15)
- Task goal description
- Read policy
- Coverage targets
- Prior rejection context (if fixing a test failure)

### SME

- Domain-specific context (up to 3 files)
- Task goal description
- Read policy
- Relevant facts from the context map
- No code-level details — SMEs operate at the domain level

## Read Policy

The read policy tells each agent whether to trust a cached file summary or read the original source. Every file in scope receives a `ReadPolicyEntry`:

| Signal | Meaning |
|--------|---------|
| `trust_summary: true, read_original: false` | The cached summary is current and sufficient |
| `trust_summary: false, read_original: true` | File not in map, or summary is stale — read the original |

Staleness is detected by comparing the stored SHA-256 content hash against a fresh hash of the current file content. This behavior is controlled by the `invalidate_on_hash_change` config option (default: `true`).

Files that are not yet in the context map always receive `read_original: true` — there is no cached summary to trust.

## Token Budget

Capsule content is bounded by `max_capsule_tokens` (default: 2000). When a capsule exceeds this limit, sections are pruned in reverse order of importance:

1. **File Details** (first to be removed)
2. **Coverage Targets**
3. **Review Checklist**
4. **Required Fix**
5. **Prior Rejection**
6. **Relevant Facts**

The **Task Goal**, **Files in Scope**, and **Read Policy** sections are mandatory and are never pruned.

Pruning uses token estimation from the shared `context-budget-service`. Each section is removed iteratively until the capsule fits within the budget.

## Telemetry

Every capsule delegation is recorded to `.swarm/context-telemetry.jsonl` as a single JSON line. Each entry contains:

- `timestamp` — ISO 8601
- `task_id`
- `agent_role`
- `delegation_reason` — one of: `new_task`, `reviewer_rejection_fix`, `critic_plan_review`, `test_failure_fix`
- `token_estimate` — estimated token count
- `cache_hits` — entries reused from context map cache
- `cache_misses` — entries requiring fresh computation
- `stale_entries` — stale entries detected during generation
- `recommended_reads` — count of files the agent should read directly
- `skipped_reads` — count of files whose cached summaries were sufficient
- `success` — whether capsule generation succeeded

To inspect aggregate statistics, use the `getTelemetrySummary()` function (available in the telemetry module). This computes:

- Total delegations
- Cache hit/miss totals
- Average token estimate
- Success rate

## Coexistence with Existing Systems

Context Capsules are designed to coexist with opencode-swarm's existing hooks and services:

### System Enhancer Hook

The system enhancer hook runs before capsule injection. Both can coexist — the enhancer enriches the system message and the capsule appends after.

### Knowledge Injector

The knowledge injector provides repository facts and conventions to the architect. Capsule injection targets delegated agents via a separate system transform hook. The `relevant_facts` section of a capsule may overlap with knowledge injector output if both are active, but they serve different audiences (architect vs. delegated agent).

### Compaction Customizer

The compaction customizer controls how system messages are compressed. Context capsules are injected before compaction runs, so compaction sees the full capsule content and can compress it as needed.

### `consolidateSystemMessages`

After all hooks run, `consolidateSystemMessages` collapses multiple `output.system` entries into a single system message. Capsule parts are merged into this consolidated message. For local models (Qwen3.6, Gemma) that require exactly one system message at index 0, this consolidation ensures the capsule content appears in the correct position.

## Known Limitations

- **Opt-in only**: The feature is disabled by default. Set `context_map.enabled: true` to activate it.
- **Capsule quality depends on map population**: If the context map is empty (when `.swarm/context-map.json` has not been created/populated yet), capsules contain minimal content. The map is populated automatically by the post-agent write-back module when `context_map.enabled === true`, or can be populated via direct persistence API calls. Capsules include richer file summaries after the map has been populated with relevant files.
- **Telemetry is append-only**: The JSONL telemetry file grows indefinitely. There is no automatic rotation or size cap. For long-running sessions, periodically delete `.swarm/context-telemetry.jsonl` to reset.

## Non-Goals

Context Capsules are **not**:

- A replacement for the knowledge system — knowledge provides persistent repository facts; capsules provide task-scoped context derived from the project's context map
- A vector database or semantic search system — capsules use exact SHA-256 hashes for invalidation, not embeddings
- A cross-project shared context mechanism — context maps are isolated per project root

## Related Documentation

- [Evidence and Telemetry](./evidence-and-telemetry.md) — telemetry infrastructure used by this feature
- [Configuration](./configuration.md) — general plugin configuration
- [Architecture](./architecture.md) — system-level architecture
