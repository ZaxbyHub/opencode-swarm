# PR Monitor Worker Never Starts Fix

## What changed

- **Removed `isGhAvailable` guard from worker startup** (`src/index.ts`):
  The PR monitor worker previously checked `isGhAvailable()` before starting.
  When the plugin host process had a different PATH than the user's terminal
  (common on Windows/macOS GUI apps), `spawnSync('gh', ['--version'])` failed
  silently, and the worker never started. The guard is removed; the worker's
  built-in circuit breaker handles gh unavailability at poll time.

- **Added startup scan for existing subscriptions** (`src/index.ts`): On plugin
  init, `listActive()` is called via a deferred `queueMicrotask` (fail-open).
  If active subscriptions exist and `pr_monitor.enabled`, the worker starts.
  Previously, the worker only started via a lazy-start callback triggered by
  new `subscribe()` calls, leaving existing subscriptions orphaned after restart.

- **Made circuit-breaker trip always-visible** (`src/background/pr-monitor-worker.ts`):
  Changed `log()` (debug-gated) to `error()` (always-visible) for circuit-breaker
  trip messages, so users see when gh CLI failures cause PR monitoring to suspend.

- **PR monitor advisories pass through to non-architect sessions**
  (`src/hooks/guardrails/messages-transform.ts`): Added `'[pr-monitor:'` to
  `TRANSIENT_PREFIXES` so PR event advisories are injected in subagent sessions
  instead of being silently drained.

## Why

Subscriptions were silently inert: `lastCheckedAt === createdAt` with
`errorCount: 0` proved zero poll cycles ran. The worker never started because
`isGhAvailable()` returned false in the plugin host process's PATH environment,
and the failure was logged via a debug-gated `log()` invisible to the user.

## How to use

No changes needed. Existing subscriptions will be automatically picked up on
next plugin restart. If gh CLI is genuinely unavailable, the circuit breaker
will trip and log a visible error after `failure_threshold` consecutive failures.

## Invariant audit

- INV-1 (init): startup scan runs via `queueMicrotask` (deferred, fail-open);
  async `listActive()` completes after setup() returns — does not block init
- INV-3 (subprocesses): no new subprocess calls; existing `ghExec` unchanged
- INV-7 (tests): existing tests pass; no `mock.module` usage
- INV-8 (session state): no session state changes
- INV-10 (chat hooks): `error()` goes to stderr, not chat-visible streams
- INV-12 (release): release fragment created
