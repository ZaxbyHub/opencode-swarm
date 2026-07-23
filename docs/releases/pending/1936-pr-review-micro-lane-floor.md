# PR review: per-tier lane-count floor for micro (risk-family) consolidation

## What changed

- Micro (risk-family) discovery lanes now have a per-tier minimum lane-count
  floor, closing the asymmetry left when depth-tiered dispatch consolidation was
  introduced: base dimensions were floored (`PR_REVIEW_BASE_LANE_FLOORS`) but
  micro sweeps could consolidate all eleven risk families into a single lane at
  tiers S and M with no minimum enforcement.
- New `PR_REVIEW_MICRO_LANE_FLOORS` (`src/hooks/pr-workflow-gate.ts`):
  **S = 1, M = 6, L = 11** (the risk-family count). The numbers mirror the base
  floors' tier *semantics* rather than their values — S does not bind (a small
  PR may consolidate a full sweep), M requires at least half the eleven families
  to get independent lanes (`ceil(11/2) = 6`, the deliberate scale-up from base
  M's `3 = ceil(6/2)`), and L requires one lane per family.
- The floor is enforced at two sites, both keyed on the controller-computed
  depth tier:
  - **Dispatch** (`validatePrReviewMicroDispatch`): a micro batch whose lanes
    collectively own all eleven families ("a full sweep") must meet the tier
    floor. Partial retry batches that cover a subset of families are exempt, so
    re-dispatching a single failed family never deadlocks.
  - **Attestation** (`write_pr_review_trigger_eval`): the previously write-only
    `dispatched_micro_lane_count` is now a gate — the durable ledger's distinct
    dispatch-lane count for the eleven families must meet the tier floor. This
    catches split-batch consolidations that slip past the per-batch dispatch
    check, since the final attestation's distinct-lane count must meet the floor
    regardless of dispatch history.
- All eleven risk families remain mandatory to evaluate on every PR; every
  family still needs its own attested `[CANDIDATE]`/`[CLEAN]` row, and the
  distinct-evidence anti-templating check is unchanged. The floor bounds *how
  far one lane may consolidate*, not *which families are reviewed*.

## Why

Without a micro-lane floor, a single subagent could nominally "cover" all eleven
risk families at tiers S/M with far less independent scrutiny than the
base-dimension floors were designed to require, and the persisted
`dispatched_micro_lane_count` recorded that consolidation degree without ever
enforcing on it. The base floors already bound base-dimension consolidation; this
restores the same guarantee for the risk-family sweep.

## Migration and compatibility

Additive and backward compatible. Singleton micro dispatch (one lane per family,
eleven lanes) validates unchanged at every tier — eleven meets every floor. Only
degenerate full-sweep consolidations below a tier's floor at S/M are newly
rejected. No tool schema, tool-registration, or persisted gate-state field
changes.
