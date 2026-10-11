# pr_workflow_status: reviewProjection (boundaries, lanes, candidate inventory)

## What

`pr_workflow_status` now projects, for an active PR_REVIEW workflow, a bounded
read-only `gate.reviewProjection` of the state the controller derives and
enforces (issue #3095), so the orchestrator can observe it without provoking a
rejection:

- **candidateInventory** — the derived candidate/review finding-id inventory,
  reusing the gate's own derivation through a new checkout-free read-only
  accessor (`readPrReviewCandidateInventoryForStatus` in
  `src/hooks/pr-workflow-gate.ts`). Capped at 50 ids with the full `total` and a
  literal `+N more` truncation note; degrades to a typed `unavailable` arm with
  a bounded reason instead of throwing (issue #2242 R4 principle). The available
  arm is never empty — the derivation yields the `CLEAN-REVIEW` sentinel — so an
  empty array can never be misread as "clean review".
- **boundaries** — per-boundary settlement phase (`post_explorer` /
  `post_reviewer` / `post_critic`: literal `settled`/`pending` words) plus the
  shared persisted checkpoint reference when at least one boundary is settled.
- **lanes** — per-lane coverage rows from three sources (base dispatches,
  validation batches, trigger-eval receipt rows for micro families) carrying
  batch/lane ids, an evidence-status marker, `itemCount` where the source record
  carries `reviewItemIds`, and capped (5) read-time finding summaries derived
  from stored receipt envelopes and lane artifacts. Nothing is duplicated to
  disk — two consecutive status calls leave the `.swarm` tree byte-identical.
  A typed per-source `sourceState` discloses read health; a corrupt
  trigger-eval receipt degrades only the micro rows.

The projection lives in a new pure module
(`src/pr-review/status-projection.ts`: no `fs`, no async, gate types only);
the tool executor performs every read, each wrapped so bad state degrades that
one source instead of failing the tool. The section is omitted entirely for
PR_FEEDBACK, no-gate, and delegation-chain-uncertain responses, which stay
byte-identical.

## Why

The controller derived and enforced per-boundary settlement, per-lane coverage,
and the candidate inventory, but the status surface exposed counts only — the
operator had to provoke a rejection to learn the authoritative inventory.

## Disclosed acceptance deviations

- **AC1 (shared checkpoint):** `prReviewArtifactBoundaries` is a flat `string[]`
  with no per-boundary timestamp, path, or digest, and its single mutator writes
  shared, last-write-wins fields. The checkpoint reference is therefore the
  shared persisted run reference current at read time, explicitly labeled
  `checkpointScope: 'shared-last-write-wins'`. Per-boundary finding attribution
  lives on the `boundary` field of each findings-JSONL row, not in gate state;
  per-boundary checkpoint persistence is deferred to #3098.
- **AC2 (no accepted/rejected item counts):** no per-item verdict exists in the
  gate state or the receipt schema at this base (`reviewItemIds` is a plain
  `string[]`, and validation batches carry no `ownedWorkflowLanes`). The lane
  rows therefore carry lane id, workflow lane, batch id, item identity where
  present, and a truthful evidence-status marker
  (`finding` / `clean` / `no-evidence` / `unknown-evidence`) instead of an
  invented verdict field. Verdict-lane predicates are owned by #3098.

## Notes

- `candidateInventory` is the first key of `reviewProjection` and `lanes` the
  last; consumers locate the inventory container by smallest-subtree search, so
  key order is part of the contract.
- The gate-file change is one additive exported accessor placed in a region
  PR #3182 does not touch (verified 0 merge conflicts against its head).
