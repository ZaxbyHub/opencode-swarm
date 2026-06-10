# Background subagents — durable dispatch tracking + completion observer (issue #1151, PR 2 Stage A)

## What

Adds opt-in, gate-safe groundwork for OpenCode v1.16.2 background subagents, building on the
PR 1 fail-closed guard.

New config (under `hooks`):
- `background_subagents` (default **false**) — when false, PR 1 behavior is unchanged
  (background swarm `Task` dispatches are fail-closed-blocked). When true, background swarm
  dispatches are **allowed and tracked**.
- `background_pending_timeout_minutes` (default 30) — bounded lifetime after which a tracked
  pending delegation is swept to `stale`.

When `background_subagents` is enabled:
- `src/hooks/delegation-gate.ts` no longer blocks background swarm dispatch; instead
  `tool.execute.after` records a **durable pending delegation** (parent session id, jobId,
  subagent session id, callID, normalized + prefixed agent, plan/evidence task id, status,
  timestamps) in an append-only `.swarm/background-delegations.jsonl` store
  (`src/background/pending-delegations.ts`). All writes run under the evidence lock; reads are
  lock-free with malformed-line tolerance; the path is `validateSwarmPath`-contained.
- A new read-only `event` hook observer (`src/background/completion-observer.ts`) watches for
  the trusted completion signal — a message part with `synthetic === true` whose text is a
  task envelope (`<task id="…" state="completed|error">`, parsed by
  `src/background/task-envelope.ts`) — and logs (under `OPENCODE_SWARM_DEBUG=1`) whether it
  correlates to a pending record.
- A lazy stale sweep (on dispatch — no plugin-init cost) transitions unresolved pendings to
  `stale`, bounding the folded in-memory view. The on-disk JSONL is append-only and not
  compacted in Stage A (each dispatch leaves a small fixed number of lines); on-disk
  compaction is a future stage.

## Why

PR 2's gate-affecting completion ingestion must only be built on a **runtime-confirmed**
trusted completion signal. The upstream signal is confirmed in source (synthetic-flagged
parent injection of a stable XML envelope, with `jobId`/subagent-session correlation), but
not yet verifiable at runtime in the pinned SDK. Stage A lands the safe, reversible
foundation — durable dispatch tracking + the empirical observation instrument — **without any
gate effect**, so the signal can be confirmed before Stage B enables advancement.

## Stage A is observe-only

A background completion does **not** advance workflow gates or record gate evidence in this
stage. Reviewer/test_engineer gates are satisfied only by foreground delegations. The
gate-affecting completion ingestion (correlate → reuse foreground transitions → exact-once,
with parent-session-gone and multi-swarm isolation handling) is **Stage B**, a separate PR
gated on runtime confirmation produced by this observer.

## Migration

No action and no behavior change for existing users — the feature is **off by default** and
preserves the PR 1 fail-closed block. Enabling requires both `hooks.background_subagents: true`
and the upstream `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.

## Invariant audit

- **4. `.swarm/` containment** — new durable store is `validateSwarmPath`-contained under
  project-root `.swarm/`; verified by tests.
- **7. Test writing** — new `bun:test` suites; no `mock.module`; positive/negative/adversarial
  (spoof/trust-gate, malformed-line, concurrent-append) cases.
- **8. Session/global state** — pending correlation is durable + session-scoped; flag-off path
  unchanged.
- **10. Chat/system message** — the observer is read-only and logs only under
  `OPENCODE_SWARM_DEBUG`; the new `event` hook is `safeHook`-wrapped (never blocks delivery).
- **1. Plugin init** — no init-time disk work added; the stale sweep is lazy on dispatch.
