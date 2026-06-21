Add durable full-output artifacts for dispatch lane results.

`dispatch_lanes`, `dispatch_lanes_async`, and `collect_lane_results` now return
bounded previews plus `output_ref` provenance for full lane transcripts stored
under `.swarm/lane-results/`. Architects can page full lane output with
`retrieve_lane_output` before candidate extraction, JSON parsing, or reviewer
routing, so long-running lanes are no longer limited by the result preview.

`output_ref` is present when the artifact was stored successfully. In degraded
cases — lane output exceeds the 10 MB per-artifact storage limit, or a write
failure occurred — `output_ref` is absent and `output_degraded: true` is set
instead. Callers should check `output_degraded` and `transcript_incomplete` as
coverage gap signals.

Migration: no configuration change required. Existing callers can keep reading
`output`; workflows that need complete lane evidence should use `output_ref` and
handle `output_degraded` or `transcript_incomplete` as coverage gaps.

Breaking changes: none.

Behavioral changes for operators with custom `exempt_tools` configuration:
- `retrieve_lane_output` is added to the `exempt_tools` default list in
  `src/config/schema.ts`. Operators who override `exempt_tools` with a full
  replacement (not an extension) will need to add `retrieve_lane_output`
  manually to preserve the exemption.
- `retrieve_lane_output` is exempt from context-budget masking so paged
  artifacts remain visible in the architect's context window.
- `retrieve_lane_output` is added to `PROBED_TOOLS` for input-probe telemetry.
