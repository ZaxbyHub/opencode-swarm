# Salvage valid PR-review discovery rows instead of discarding whole lanes

## What changed

- A PR-review discovery artifact is now **normalized once** before every consumer
  reads it. `normalizeCandidateArtifact` (`src/background/candidate-contract.ts`)
  repairs an absent canonical header by synthesizing it in front of the first
  marker-bearing row, and is applied at the coverage site, the candidate-id
  extraction site, and the `parse_lane_candidates` tool boundary.
- A malformed row no longer discards a lane's valid findings. Coverage is
  established from the valid rows; defective rows are reported as diagnostics.
  Duplicate `candidate_id`s remain non-salvageable, because the inventory they
  feed is asserted globally unique.
- A defective `[CLEAN]` attestation no longer discards the candidate rows beside
  it (`src/background/candidate-parser.ts`) — a bad attestation discredits the
  attestation, not independently validated findings.
- A zero-findings lane that emitted a well-formed `[CLEAN]` but omitted the header
  is now repaired. This was the single lane that blocked a real run across four
  attempts.
- The explorer output contract (`src/tools/dispatch-lanes.ts`) now teaches
  `\|` escaping, leads with a worked example, and states the `[CLEAN]` row shape.
- The row family is resolved by one mode-first rule
  (`resolvePrReviewRowFamily`), so coverage and extraction can no longer disagree
  about which family an artifact contains.
- Repaired lanes are recorded as `salvagedWorkflowLanes` on the durable delegation
  ledger, so a salvaged artifact stays distinguishable from a well-formed one.

## Why

Measured on a real run (reconstructed from `.swarm/background-delegations.jsonl`):
99.3 minutes, 31 lane dispatches, 16 errored lane instances, **59 substantive
findings discarded, 0 artifacts persisted**. Zero of those failures were analysis
failures — every one was a text-formatting failure on the positional
pipe-delimited candidate protocol, validated with no salvage.

Because the gate fails the whole workflow on any unresolved micro source, a single
lane that found nothing and said so correctly — but omitted one header line —
ended the run.

## Migration steps

None. No configuration, schema migration, or persisted-state change is required.
`salvagedWorkflowLanes` is an optional field on existing ledger records.

## Breaking changes

None at the API level. Four previously-pinned validation behaviours were
deliberately relaxed, each with its reasoning recorded in the corresponding test:

- an absent canonical header is repaired rather than fatal, when at least one
  valid row or a well-formed lane-bound `[CLEAN]` is present;
- a valid row followed by a malformed row now establishes coverage;
- a headerless `[CLEAN]` establishes coverage;
- a lane whose *second* row carries a mislabeled lane value is no longer
  discarded when a correctly-labeled row already covers the dimension.

The proof-of-work bar is unchanged: coverage still requires a semantically valid
row whose lane matches, or a `[CLEAN]` clearing its `coverage_scope` and
`evidence` length floors. A wrong or late header, a foreign-lane attestation, and
duplicate candidate ids all still fail closed.

## Known caveats

- Lanes that produce no text at all (`stale`, `cancelled`, or left `running`)
  cannot be salvaged by construction.
- A zero-findings lane that wraps its `[CLEAN]` in a markdown code fence remains
  unsalvageable, because fence-stripping removes the trigger before it is read.
- The emission-hardening half is validated for delivery into the lane prompt, not
  for lane compliance, which is not unit-testable.

These and the remaining follow-on items are tracked in #2114.
