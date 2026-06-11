# PR Monitor — Phase 2: Polling Worker, Event Subscribers, and Async gh Wrappers

## What

Phase 2 of the GitHub PR Monitor (FR-001) adds the background polling engine and event delivery. Phase 1 infrastructure is now wired up and operational.

### Polling Worker (`src/background/pr-monitor-worker.ts`)

New ~850-line `PrMonitorWorker` class with bounded, fail-open lifecycle (start/stop/dispose). Core polling logic:

- **Two-phase change detection** — `computeChanges()` diffs current PR state against the last stored snapshot; `applyChanges()` atomically emits events and persists updates
- **Four async gh wrappers** called per PR per cycle: `getPRStatus`, `getPRComments`, `getMergeState`, `getPRReviewState`
- **Per-subscription circuit breaker** — tracks `errorCount`, `suspendedUntil`, and `cooldownLevel`; exponential backoff with configurable ceiling
- **Cooperative timeout cancellation** — `CancellationToken` with 6 guard points (before each gh call, before state merge, before event emission, before snapshot write, before unsubscribe check, before next cycle)
- **Bounded concurrency** — `max_concurrent_gh_processes` limits simultaneous gh spawns; `max_prs_per_cycle` caps PRs polled per tick
- **Stale subscription sweep** — `sweepStale()` runs each cycle, removing merged/closed PRs regardless of event state

### New Async gh Wrapper (`src/git/pr.ts`)

Added `ghExecAsync` — async, non-blocking counterpart to `ghExec` using `spawn` (not `spawnSync`). Follows Invariant 3: array-form spawn, explicit `cwd`, `stdin: 'ignore'`, bounded stdout/stderr, `proc.kill()` in `finally`. Used exclusively by background workers to avoid blocking the event loop.

### Review State Wrapper (`src/git/pr.ts`)

Added `getPRReviewState(prNumber, repoFullName, cwd)` → `ReviewStateResult`:
- `reviewDecision`: `APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''`
- `reviewRequestCount`: number of pending reviewer requests

Emits `pr.review.approved` and `pr.review.changes_requested` events on transitions.

### Event Subscribers (`src/background/pr-event-subscribers.ts`)

Four subscribers attach to the AutomationEventBus and forward PR events to subscribed sessions:
- `notifyCiFailure` — fires on `pr.ci.failed`
- `notifyNewComment` — fires on `pr.new.comment`
- `notifyMergeConflict` — fires on `pr.merge.conflict`
- `notifyReviewStateChange` — fires on `pr.review.approved` / `pr.review.changes_requested`

All subscribers use a **deduplication token** (event type + PR number) to suppress repeat notifications within a cooldown window.

### Plugin Wiring (`src/index.ts`)

- `prMonitorWorker: PrMonitorWorker | null` singleton, initialized lazily on first `subscribe()` call
- Gated by `pr_monitor.enabled === true` AND `gh` binary availability check (`gh help` → `spawnSync` with 5s timeout)
- Signal handlers (SIGTERM/SIGINT on POSIX, process.on('exit') on Windows) call `worker.stop()` before the process exits
- `dispose()` called on plugin unload

## Why

Phase 1 established the config schema, subscription store, and gh wrapper types. Phase 2 wires them into a working background engine:

- The worker is the runtime consumer of the subscription store and gh wrappers — without it, subscriptions are recorded but nothing is polled
- Async `ghExecAsync` is required because background polling must not block the Node.js event loop (the sync `ghExec` blocks on `spawnSync` waiting for gh to exit)
- Event subscribers are the bridge from the AutomationEventBus to live session notifications — they convert bus events into session-directed advisories
- Plugin wiring (lazy start, signal handlers, cleanup) ensures the worker behaves correctly as a long-running background process inside the OpenCode plugin host

## Migration

No action for existing users. Phase 2 is additive — it activates automatically once `pr_monitor.enabled: true` is set and `gh` is authenticated.

## Invariant audit

- **1. Plugin init** — worker is lazy-start on first subscribe; no init-time work; signal handlers registered after worker construction
- **2. Runtime portability** — `ghExecAsync` uses Bun-compatible `spawn` (not `bun:*`); `spawnSync` path unchanged; worker runs in Node.js plugin host
- **3. Subprocesses** — `ghExecAsync` follows all Invariant 3 requirements: array-form `spawn`, explicit `cwd`, `stdin: 'ignore'`, timeout, bounded stdout/stderr, best-effort `proc.kill()` in `finally`
- **4. `.swarm/` containment** — worker uses `ctx.directory` from `createSwarmTool` pattern; store path unchanged from Phase 1
- **7. Test writing** — `_internals` DI seam on `ghExec`/`ghExecAsync` enables `mock.module`-leak-safe unit tests
- **8. Session state** — worker is process-scoped singleton; subscriptions survive session restart but worker does not (intentional — worker is bound to process lifetime)
- **11. Tool registration** — Phase 2 is infrastructure only; no new tools registered
