# PR Monitor Infrastructure — Phase 1: Config Schema, Subscription Store, and gh CLI Wrappers

## What

Phase 1 foundation for the GitHub PR Monitor (FR-001). Three infrastructure pieces landed:

### Config Schema (`src/config/schema.ts`)
Added `PrMonitorConfigSchema` with 16 fields (lines 1464–1503):
- `enabled` (master flag, default false), `poll_interval_seconds`, `max_subscriptions`, `max_prs_per_cycle`, `max_concurrent_pr_polls`, `poll_timeout_ms`, `failure_threshold`, `cooldown_seconds`, `max_cooldown_seconds`, `cleanup_ttl_days`, `auto_unsubscribe_on_merge`, `auto_unsubscribe_on_close`, `notify_ci_failure`, `notify_new_comments`, `notify_merge_conflict`, `auto_pr_feedback`
- All fields strictly validated with Zod; added to `PluginConfigSchema` as `pr_monitor: PrMonitorConfigSchema.optional()`
- **Auto-subscribe**: when `pr_monitor.enabled: true`, PR monitoring is available without an additional feature flag

### gh CLI Wrappers (`src/git/pr.ts`)
Exported `ghExec` with `_internals` DI seam (mirrors the `gitignore-warning.ts:_internals` pattern for test isolation). Added four PR wrapper functions:
- `getPRStatus(prNumber, repoFullName, cwd)` → `PRStatusResult` (state, mergeable, mergeStateStatus, headRefOid, statusCheckRollup)
- `getPRChecks(prNumber, repoFullName, cwd)` → `PRCheckResult[]` (name, bucket, state, startedAt, completedAt)
- `getPRComments(prNumber, repoFullName, cwd, since?)` → `PRCommentResult[]` (issue comments + PR review comments merged, deduplicated)
- `getMergeState(prNumber, repoFullName, cwd)` → `MergeStateResult` (mergeable, mergeStateStatus, headRefOid)

### Durable Subscription Store (`src/background/pr-subscriptions.ts`)
New append-only JSONL store under `.swarm/pr-monitor/subscriptions.jsonl`:
- `subscribe(directory, input)` — idempotent; appends `active` record; enforces `maxSubscriptions` cap
- `unsubscribe(directory, correlationId)` — appends `removed` snapshot
- `updateSnapshot(directory, correlationId, updates)` — merges updates, preserves identity fields
- `listActive(directory)` — lock-free read, returns all `active` subscriptions
- `lookupByPr(directory, repoFullName, prNumber)` — lock-free single-PR lookup
- `sweepStale(directory, ttlDays, mergedPrs?)` — marks stale subscriptions `expired`; merged/closed PRs swept regardless of event state
- All writes under `withEvidenceLock` (project-scoped); reads are lock-free with malformed-line tolerance
- Path validated with `validateSwarmPath` (Invariant 4 containment)

### State Integration (`src/state.ts`)
- Added `prSubscriptions: Map<string, PrSubscriptionState>` to `AgentSessionState` (lines 103–112, 334)
- Session rehydration (`startAgentSession`) calls `rehydratePrSubscriptions(sessionId, directory)` — fail-open on errors

### Event Bus Extensions (`src/background/event-bus.ts`)
Added 13 PR event types to `AutomationEventType` union (lines 44–56):
`pr.subscribed`, `pr.unsubscribed`, `pr.status.updated`, `pr.ci.failed`, `pr.ci.passed`, `pr.new.comment`, `pr.merge.conflict`, `pr.merge.conflict_resolved`, `pr.merged`, `pr.closed`, `pr.review.approved`, `pr.review.changes_requested`, `pr.subscription.expired`

### Snapshot Rehydration (`src/session/snapshot-reader.ts`)
Added `prSubscriptions: new Map()` to `deserializeAgentSession` (line 192) — PR subscriptions do not survive process restart (intentional; background poller is session-scoped).

## Why

PR Monitor is a multi-phase feature. Phase 1 lands the **safe, bounded, fail-open** infrastructure that other phases build on:
- Config schema is the contract all future phases implement against
- gh wrappers provide a testable, DI-seamed interface to the `gh` CLI (no direct `child_process` in polling logic)
- The subscription store is the durable state anchor — multiple sessions can subscribe to the same PR independently (composite key: sessionID + repoFullName + prNumber)
- Event bus integration means the polling engine only needs to call `eventBus.publish()`; downstream consumers (notifications, hooks, commands) subscribe independently

## Migration

No action for existing users — `pr_monitor` is absent from config by default and the schema is `.strict()`. Add `"pr_monitor": { "enabled": true }` to opt in.

## Invariant audit

- **1. Plugin init** — no init-time disk work; store is lazy on first subscribe
- **3. Subprocesses** — gh wrappers use array-form `spawnSync` with explicit `cwd`, `timeout`, `stdio`; `_internals.ghExec` DI seam enables unit test replacement
- **4. `.swarm/` containment** — store path validated with `validateSwarmPath`; `pr-monitor/` subdirectory created with `recursive: true`
- **7. Test writing** — `_internals` DI seam pattern (same as `gitignore-warning.ts`); `mock.module`-leak-safe
- **8. Session state** — `prSubscriptions` is session-scoped Map; rehydration is fail-open
- **11. Tool registration** — Phase 1 is infrastructure only; no new tools registered yet
