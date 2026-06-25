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
- Rotation is now active in production. The rotated file is `telemetry.jsonl.1`
  (overwritten on each subsequent rotation — only one backup generation is
  retained). Consumers that previously tailed `telemetry.jsonl` for unbounded
  growth will now see the file renamed and replaced at approximately 10 MB.
  Downstream analytics pipelines and log shippers should either reopen
  `telemetry.jsonl` after rotation or read both `telemetry.jsonl` and
  `telemetry.jsonl.1` to avoid missing events.

## Behavioral change for downstream consumers

Prior to this fix, `rotateTelemetryIfNeeded()` was fully implemented but never
called from `emit()`, so `telemetry.jsonl` grew without bound regardless of the
documented 10 MB threshold. The function is now wired into the emit path behind
a 50-emit throttle, so rotation actually occurs at runtime.

When rotation fires:

1. The current `telemetry.jsonl` is renamed to `telemetry.jsonl.1`.
2. A fresh `telemetry.jsonl` is opened for subsequent writes.
3. On the next rotation event, `telemetry.jsonl.1` is overwritten — only a
   single backup generation is kept.

Consumers that tail or stream `telemetry.jsonl` should account for this
lifecycle:

- **Tail-following consumers** (e.g., `tail -F`, log shippers): the file handle
  will point at a renamed file after rotation. Reopen `telemetry.jsonl` when the
  inode or path changes, or watch for the appearance of `telemetry.jsonl.1` as a
  rotation signal.
- **Batch analytics jobs**: read both `telemetry.jsonl` (current) and
  `telemetry.jsonl.1` (most recent rotated batch) to capture the full event set
  across a rotation boundary.
- **Consumers expecting unbounded growth**: the file will no longer grow past
  ~10 MB without rotation. Any logic that assumes a monotonically growing single
  file will need adjustment.

## Migration

No migration required. This is a bug fix restoring intended (and documented)
behaviour; the rotation threshold and single-generation overwrite policy are as
originally specified.
