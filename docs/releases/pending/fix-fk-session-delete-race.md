# Fix: await server-side `session.abort()` before `session.delete()` to stop the ephemeral-session FK race (#2123)

## What changed

Every ephemeral subagent session teardown now **awaits a server-side
`session.abort()` before `session.delete()`** so opencode finishes flushing the
final assistant `part`/`message` before the cascade-delete removes the parent
rows. This closes the `FOREIGN KEY constraint failed` race reported in #2123.

opencode's `SessionProcessor.cleanup` writes the final assistant part/message
**asynchronously, after `session.prompt()` resolves**, as a stream-drain
finalizer. The `part.message_id` foreign key is `ON DELETE CASCADE`, so a
`session.delete()` that landed before that flush removed the parent `message`
row; opencode's late `updatePart`/`updateMessage` write then failed with
`SQLiteError: FOREIGN KEY constraint failed` in opencode's log (the plugin's own
`session.delete()` promise resolved fine, which is why a `.catch(() => {})` on
the delete could not prevent it).

### Why awaiting `session.abort()` fixes it

`POST /session/{id}/abort` resolves only after opencode's
`SessionRunState.cancel` → `Runner.cancel` → `Fiber.interrupt(runFiber)`.
Effect's `Fiber.interrupt` runs every finalizer on the target fiber before
resolving, and the run-loop fiber carries `Effect.ensuring(cleanup())`. So once
`await session.abort()` returns, the final part/message flush has already
landed (or the session was already idle, in which case cleanup ran during
natural completion). The delete that follows can no longer race the flush.
(Source: opencode v1.18.16 — `packages/opencode/src/session/{run-state,runner,processor}.ts`.)

### Where the fix lands

A new helper owns the ordering for non-evaluation sites:
- **`src/utils/ephemeral-session-teardown.ts`** (new) — `teardownEphemeralSession(session, id, opts)`:
  a bounded `await session.abort()` followed by a bounded `await session.delete()`,
  best-effort (never throws), with an `_internals` DI seam for tests.

The awaited-dispatch path (evaluation/review) gets the same ordering inline:
- **`src/evaluation/ephemeral-agent-dispatcher.ts`** — added
  `boundedAbortEphemeralSession(client, id, timeoutMs)`; `dispatchEphemeralAgent`'s
  `finally` now does `await boundedAbort(...)` before the existing
  `await boundedDelete(...)`.
- **`src/evaluation/model-dispatcher.ts`** — `_internals` test proxy extended with
  `boundedAbort` for DI symmetry.

All call sites that previously fired `session.delete(...).catch(() => {})`
fire-and-forget are routed through the awaited-abort teardown:
- `src/hooks/curator-llm-factory.ts`, `src/hooks/skill-improver-llm-factory.ts`
- `src/tools/dispatch-lanes.ts` (`scheduleSessionCleanup`, `cleanupAsyncLaunchSession`)
- `src/turbo/lean/runner.ts` (4 sites; `SessionClient` extended with optional `abort`)
- `src/turbo/lean/integration.ts`, `src/mutation/generator.ts`
- `src/full-auto/oversight.ts` (2 sites), `src/hooks/full-auto-intercept.ts` (2 sites)

The prior partial mitigation (forwarding a local `AbortController` signal to
`session.prompt()` and calling `controller.abort()` before delete) is preserved
where present — it cancels the plugin's own in-flight fetch — but it does not
stop opencode's server-side flush, which is why the race persisted until this
change added the awaited server-side abort.

## Why

Without the awaited abort, ephemeral curator (and other delegation) sessions
lost their final assistant text part and logged an ERROR on every occurrence.
DB integrity was otherwise intact (`PRAGMA integrity_check` = ok); the bug was
non-fatal but noisy and lossy.

## Migration steps

None. Internal session-lifecycle change; no API, config, or storage surface
changes.

## Breaking changes

None.

## Known caveats

- The awaited abort adds at most a single fast HTTP round-trip in the common
  case (session already idle → abort is a no-op). Under mid-interruption it can
  take up to ~250 ms+ (opencode's cleanup awaits pending tool-call deferreds
  with a 250 ms timeout); the abort step is bounded at 5 s to stay well clear.
- Fire-and-forget teardown sites (lane/runner result-timing paths) preserve
  their original non-blocking semantics — the abort→delete ordering holds
  inside the teardown unit, so the race is closed without changing when the
  caller's result returns.
