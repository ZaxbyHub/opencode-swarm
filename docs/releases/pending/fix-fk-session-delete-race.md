# Fix: abort in-flight prompt before session.delete() to prevent FK crashes

## What changed

All 8 callsites that create ephemeral sessions via `client.session.create()` and then
prompt via `client.session.prompt()` now forward an `AbortController` signal to the
prompt call and invoke `controller.abort()` before calling `session.delete()`.

The fix covers:
- `src/tools/dispatch-lanes.ts` — `runLane()` and `withTimeout()` helper
- `src/hooks/auto-review.ts` — `dispatchReviewer()`
- `src/hooks/full-auto-intercept.ts` — `dispatchCriticAndWriteEvent()`
- `src/mutation/generator.ts` — `generateMutants()`
- `src/full-auto/oversight.ts` — `dispatchFullAutoOversight()`
- `src/turbo/lean/reviewer.ts` — `defaultDispatchReviewerAgent()`
- `src/turbo/lean/integration.ts` — `defaultDispatchCriticAgent()`
- `src/turbo/lean/runner.ts` — `LeanTurboRunner.dispatchLane()`

Secondary fixes in the same PR:
- **Timer leaks** in `reviewer.ts`, `integration.ts`, and `runner.ts`: `setTimeout`
  handles are now stored and cleared in `finally` blocks on success paths.
- **Session leak** in `runner.ts` `_doDispatch`: hoisted `sessionId` to outer scope so
  `session.delete()` fires in the `catch` block when `session.prompt()` throws.

## Why

When a timeout fires mid-prompt, `session.delete()` removed the session row from
SQLite while OpenCode's `SessionProcessor` was still writing `message` rows that
reference `session.id`. The FK constraint (`message.session_id → session.id`) then
failed with `SQLiteError: FOREIGN KEY constraint failed`, producing a visible error
loop in the host application.

The root cause is a delete-before-cancel race: `session.delete()` fired before the
HTTP fetch backing `session.prompt()` was cancelled. Calling `controller.abort()` first
causes the SDK to cancel the in-flight request, so the `SessionProcessor` stops writing
before the session row disappears.

The fix pattern was already deployed in `curator-llm-factory.ts` and
`skill-improver-llm-factory.ts` with a documented comment about FK crashes; this PR
applies it uniformly to all remaining callsites.

## Migration steps

No migration required. This is an internal change to session lifecycle management with
no API or configuration surface changes.

## Breaking changes

None.

## Known caveats

None.
