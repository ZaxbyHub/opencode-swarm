# PR workflow lifecycle and human cancellation recovery

## What changed

- The human `/swarm abort-pr-workflow` command now supports the explicit
  `PR_FEEDBACK --cancel-publication <reason...>` form for cancelling an armed
  publication without publishing. It requires a reason, records the terminal
  `cancelled_without_publication` result, and reports the observed remote head.
- Dead PR-review source scanners are test-owned rather than exported from the
  runtime package; their synthetic bite and source-tree regression coverage is
  preserved.
- Exact-owner `session.deleted` and `session.removed` events now call
  `terminalizePrWorkflowGateForSession` first, then best-effort
  `reconcilePrWorkflowCheckoutReceipts`. Verified, marked PR-workflow stashes
  are collected with their receipts; pending, unknown, ordinary, and failed
  cleanup cases remain preserved and recoverable.
- `prepare_pr_workflow_checkout` reports a missing preserved stash as
  `success: false`, `code: CHECKOUT_RESTORE_STASH_MISSING`,
  `status: incomplete`, and `recoverable: true` while keeping the receipt
  visible. A later explicit preparation retires that receipt only after the
  bounded `pr_workflow_checkout_stash_missing` evidence append and exact
  receipt deletion both succeed.
- Corrupt coordination recovery remains surfaced by the existing
  `/swarm abort-pr-workflow` path through `state_salvaged`,
  `state_salvage_disclosure`, and `cas_escape_disclosure` when applicable.
- No migration or breaking command-contract change is required; existing
  cancellation, recovery, and manual restore forms remain supported.

## Why

This makes the audited no-publish exit reachable from the human command while
keeping ordinary force recovery unchanged, closes deletion-time PR workflow
state and receipt/stash wedges, and removes guardrail code that had no
production caller.

Closes: #2602
