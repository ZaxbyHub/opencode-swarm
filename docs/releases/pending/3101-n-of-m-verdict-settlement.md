# N-of-M truthful verdict settlement for liveness-dead verdict lanes (issue #3101)

## What changed

- When a reviewer or critic verdict lane is liveness-dead (controller-written typed `workflowLaneFailureClass: 'liveness'` on the durable delegation record) and the item-scoped retry budget is exhausted (`PR_REVIEW_VERDICT_RETRY_BUDGET = 2` retries, mirrored from the micro-family budget), PR-review verdict settlement now settles truthfully over the surviving items instead of forcing retry-to-BLOCKED or a whole-run abort.
- The settlement persists an immutable per-item disclosure receipt at `.swarm/pr-review/<runId>/verdict-settlement.<phase>.json` — one structured row per dead item (itemId, sourceBatchId, sourceLaneId, disposition `liveness_dead`, evidenceClass `liveness`, terminalStatus) — mirroring the `coverage_degradations` disclosure shape (issue #2835/#2840 lineage) as a new surface with structured fields.
- The disclosed settlement downgrades the verdict matrix through the existing `DEGRADED_DISCLOSED` channel: a settled review reports REQUEST_CHANGES or INCOMPLETE, never APPROVE, with no synthesized verdicts for dead items. The `(dead family)` rejection wording generalizes to `(dead family or dead verdict lane)`.
- Surviving items keep critic coverage: the partial reviewer map still derives the critic inventory, and a dead critic lane settles its items as a disclosed, writer-derived terminal `CRITIC_UNAVAILABLE` disposition (the model never authors that status; a model-supplied `critic_status` on a disclosed-dead item is rejected).
- Findings records: disclosed-dead reviewer items are exempt from exact-cover only (no record required — the architect cannot produce a verdict for them); a verdict-bearing record for such an item is a named violation. `complete_pr_workflow`'s report carries an additive `verdict_settlement` disclosure echo.
- Fail-closed everywhere: silence (no delegation records), lane self-report (classless error transitions), uncertain store reads, and items with empty owner sets (un-declared or capacity-GC-pruned) all keep settlement blocking; an item claimed after the receipt was written drops out of the effective disclosure set.

## Why

Issue #3101 ([Workstream S] PR 2 of 2, epic #3102): a liveness-dead verdict lane previously left the run's only exits as re-dispatch or `abort_pr_workflow`, discarding validated work from live lanes. This applies the #2383 N-of-M settlement shape to the verdict phase under the validated four-constraint design (terminality-evidence-only trigger / silence-blocks / downgrade-only / per-item disclosure). The rejected alternative — generalizing `bound_fallback` to verdicts — stays rejected: a verdict artifact is the first write of its fact, so disclose-and-proceed there would trust silence.

## Notes

- Deliberate narrowing: AC1's "liveness-dead receipt or retry-budget exhaustion" is implemented as the CONJUNCTION (both required), a strict subset of the permitted trigger set.
- Design note (deviation from plan M2, disclosed for review): the gate-state mirror field `prReviewVerdictSettlement` is not persisted; the receipt file itself carries the full identity binding (runId/prHeadSha/revisionDigest/phase), verified at every read.
- Tests: new `tests/unit/pr-review/n-of-m-verdict-settlement.test.ts` (8 tests: settle+critic-coverage, liveness-evidence negative, empty-owner negative, critic-death, downgrade-only projections, CRITIC_UNAVAILABLE semantics, receipt fields, budget arithmetic); `issue-2840-verdict-call-site-wiring` line pins re-pinned for the shifted call sites.
