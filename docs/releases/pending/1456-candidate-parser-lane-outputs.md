# Candidate parser for durable lane outputs

## What changed

- **New `parse_lane_candidates` tool** (`src/tools/parse-lane-candidates.ts`):
  Parses `[CANDIDATE]` rows from a `dispatch_lanes` or `collect_lane_results` artifact (by `output_ref`), produces structured records with provenance, and optionally persists to a per-batch sidecar JSONL. Pure-parser variant exists as an internal module.

- **Tool arguments**:
  - `output_ref` (required) — path or reference to the lane artifact
  - `accept_partial` — allow partial parsing
  - `accept_degraded` — allow degraded lane artifacts
  - `degraded` — treat as degraded
  - `row_format_version` — row format version hint
  - `producer` — producer identifier
  - `use_lockfile` — use lockfile for sidecar writes
  - `project_root` — project root override

- **Return type**: `ParseResultWithSidecar`:
  - Success: `{ candidates, invocation_envelope, diagnostics, sidecar_write_error? }`
  - Refusal: `{ error, error_code, candidates: [], invocation_envelope, diagnostics, sidecar_write_error? }`

- **Registered agents**: `architect` only (per `src/tools/tool-metadata.ts`)

- **`swarm-pr-review` skill updated**: The skill's Phase 3 section now uses `parse_lane_candidates` instead of preview-text extraction for candidate isolation. Dry-run example updated to show non-null envelope/diagnostics.

## Why

Lane outputs from `dispatch_lanes_async` and `collect_lane_results` are persisted artifacts containing structured `[CANDIDATE]` rows. The `parse_lane_candidates` tool provides a structured, fail-open parser for extracting these candidates with full provenance, replacing ad-hoc text extraction in the `swarm-pr-review` skill.

## Migration steps

None. The tool is additive and architect-only; existing workflows are unaffected unless they explicitly opt into the parser-based extraction path in `swarm-pr-review`.

## Breaking changes

None.

## Known caveats

- Tool is registered to `architect` only; other agents receive an error if they attempt to call it.
- The pure-parser internal module (`_internals` seam) exists separately for testing without the full tool wrapper.
