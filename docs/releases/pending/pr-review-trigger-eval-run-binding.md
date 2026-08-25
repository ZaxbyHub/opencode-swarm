# PR-review trigger-eval receipt immutability and run binding

## What changed

- The PR-review trigger-evaluation receipt (`.swarm/pr-review/<run_id>/trigger-eval.json`) is immutable after publication. An exact repeat under the same `run_id` is an idempotent recovery that repairs a missing gate receipt without rewriting the artifact; conflicting content fails closed. The receipt remains bound to a single `run_id` for the session (mirroring the existing `prReviewArtifactRunId` binding for the findings artifact).
- The trigger-eval `run_id` and the findings-artifact `run_id` must now agree, since both live under the same `.swarm/pr-review/<run_id>/` directory. A mismatch fails closed at the writer pre-check and at the gate boundary.
- The stale `bindPrReviewTriggerLedger` block message no longer claims the ledger must be byte-identical "and the final receipt" — PR #2121 narrowed the final receipt to a per-family classification check, so only the per-micro-dispatch ledger must remain identical.
- The `swarm-pr-review` skill's "Aborting an unrecoverable review" section now documents trigger-ledger drift as a second stranding class with the same abort exits.

## Why

The receipt is a tamper-evident coverage proof consumed once per review run. Before this change, `run_id` was never bound to the gate state and the destination write clobbered on rename, so a repeat write could replace an already-consumed receipt (and several receipts under different self-chosen `run_id` values could persist within one session). Closes #2124, #2125, #2126.

## Migration

None. The new `prReviewTriggerEvalRunId` gate-state field is optional and additive; older persisted gate state reads cleanly through the existing `.passthrough()` schema. Existing callers are unaffected — the `write_pr_review_trigger_eval` tool passes its `run_id` argument through automatically.

## Breaking changes and known caveats

- A conflicting `write_pr_review_trigger_eval` call for an already-persisted receipt still hard-fails. Exact retries are safe after response loss or a crash between artifact publication and gate-state persistence.
