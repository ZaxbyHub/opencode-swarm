# Fix: telemetry.jsonl never rotates — rotateTelemetryIfNeeded was unwired

## What changed

`rotateTelemetryIfNeeded()` was fully implemented (stat → rename → fresh file) and
unit-tested, but never called from any production code path. The telemetry emit
function (`emit()` in `src/telemetry.ts`) wrote to `telemetry.jsonl` indefinitely,
so the file grew without bound in production despite the docs promising 10 MB
rotation.

The fix wires `rotateTelemetryIfNeeded()` into `emit()` behind a counter throttle
(`ROTATION_CHECK_INTERVAL = 50`):

- The hot path pays only a single integer increment (`_emitCount++`) per emit.
- Every 50th telemetry write triggers one `statSync` + potential rename, keeping
  per-call overhead negligible on the tool-call hot path.
- `rotateTelemetryIfNeeded` already guards on file size and swallows errors, so
  calling it opportunistically is safe.

`rotateTelemetryIfNeeded` is also added to the `_internals` DI seam for testability,
and two regression tests are added:

1. A spy test verifying the counter throttle fires rotation exactly every
   `ROTATION_CHECK_INTERVAL` emits.
2. An end-to-end test verifying that `emit()` actually bounds
   `telemetry.jsonl` size by rotating the file in place.

## Why

Issue #1273 — unbounded `telemetry.jsonl` growth in production. The rotation
logic existed but was dead code; the docs claimed 10 MB rotation that never
happened.

## Impact

- `telemetry.jsonl` now rotates when it exceeds the configured threshold, capping
  on-disk growth.
- No per-tool-call hot-path cost increase (one integer increment per emit; the
  `statSync` fires at most once per 50 writes).
- No breaking changes. The rotation threshold and behaviour are unchanged — only
  the missing call site is wired in.

## Migration

No migration required. Pure bug fix restoring intended (and documented) behaviour.
