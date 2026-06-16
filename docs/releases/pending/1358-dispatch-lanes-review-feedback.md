# Dispatch-lanes review feedback fixes

Addresses review findings on the `dispatch_lanes` tool introduced in PR #1358.

## What changed

- Hardened the read-only lane tool denylist to also block `summarize_work` and
  `doc_scan`, preventing read-only lanes from mutating `.swarm/` evidence or the
  documentation manifest cache.
- Fixed `boundLaneOutput` so the returned string never exceeds
  `MAX_LANE_OUTPUT_CHARS` (20,000), including the truncation suffix.
- Replaced the `formatError` `JSON.stringify` fallback with a safe, bounded
  `String()` representation that handles circular objects and non-Error thrown
  values without leaking large payloads.
- Removed a no-op identity catch in the `runLane` session-create timeout path.
- Added regression tests for duplicate lane ID rejection, schema boundary
  validation (empty/missing fields, `max_concurrent`, `timeout_ms`), and
  `max_concurrent` clamping behavior.

## Why

The original `dispatch_lanes` implementation passed CI but left several review
findings unaddressed: write-adjacent tools were still exposed to read-only
lanes, output truncation could exceed the documented limit, error formatting
could throw on circular structures, and key schema/validation paths lacked unit
 test coverage.

## Migration

No migration required. The tool's public shape and arguments are unchanged;
only internal correctness and test coverage improved.

## Caveats

- `Error.message` strings are still returned verbatim without truncation. This
  is intentional for `Error` instances; only non-Error thrown values are
  bounded to `MAX_ERROR_CHARS`.
