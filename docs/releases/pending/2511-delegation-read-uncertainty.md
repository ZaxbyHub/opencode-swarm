# 2511-delegation-read-uncertainty

## Fixed

- A temporarily unreadable delegation store no longer masquerades as an empty
  one. The advisory reader `readDelegationsDetailed` (new,
  `src/background/pending-delegations.ts`) returns a typed
  loaded/healthy-empty/uncertain result with a bounded reason: an explicitly
  uncertain load retries exactly once within a documented budget
  (`DELEGATION_READ_RETRY_DELAY_MS`, 2 attempts + one 25 ms delay), and a
  second failure stays typed uncertainty — recorded as stale evidence in the
  existing delegation-health artifact, never as current proof. The legacy
  array-shaped `readDelegations`/`findByBatchId`/`findByCorrelationId` remain
  as documented maintenance conveniences; typed `*Detailed` variants are the
  decision-path API.
- PR-workflow terminal paths fail closed on an unreadable store instead of
  clearing gates over possibly-live lanes: `completePrWorkflow`,
  `abortPrWorkflow` (including `force` — an override of KNOWN lanes, not of an
  unreadable store), armed recovery, the PR_REVIEW→PR_FEEDBACK transition, the
  PR_FEEDBACK rebind in-flight guard, and `submitPrReviewResult` (which now
  rejects with a truthful "store unreadable" reason instead of a misleading
  "found 0"). A healthy empty store still completes through its valid
  INCOMPLETE route — uncertainty and legitimate emptiness are distinct.
- PR-review terminal coverage no longer labels dispatched dimensions
  NOT_LAUNCHED when the batch read failed: uncertainty is carried on the
  settlement instead of being converted into false absence or fabricated
  FAILED rows. `collect_lane_results` reports a distinct
  `store_unreadable` failure class (genuine `not_found` stays reserved for
  real absence) and never exits its poll as all-settled on an unreadable
  re-read; `dispatch_lanes_async` refuses a dispatch whose batch uniqueness
  cannot be verified.
- Terminal settlement distinguishes "record missing" from "store unreadable"
  (`settleDelegationTerminal` gains a typed `uncertain` outcome), and the
  completion observer defers trusted terminal receipts on an unreadable store
  (leaving them pending and re-attemptable) instead of dropping them as
  "no durable owner".
- `pr_workflow_status` now resolves gate ancestry through the same bounded
  resolver machinery the enforcing gate uses (host-parent fallback included,
  first-hop only — a broken intermediate chain still reports
  `delegation-chain-uncertain`), and reports a bounded recovery section:
  controller session, delegation-read state (ok/uncertain + reason code),
  last durable revision progress, wake suspension, and a typed
  action-circuits state that is truthfully `unavailable` when the status
  tool has no live invocation context — plus an executable next step.

## Added

- Telemetry event `delegation_read_uncertain` (catalog + union + contract
  doc): bounded, content-free payload `{attempt, reasonCode, source}` emitted
  at most once per store root per 60 s cooldown, only when the advisory read
  stays uncertain after its bounded retry. Rides the existing
  `.swarm/telemetry.jsonl` stream — no new sink (issues #2482/#2511).

Reference: issue #2511 (Workstream H, PR slot 6).
