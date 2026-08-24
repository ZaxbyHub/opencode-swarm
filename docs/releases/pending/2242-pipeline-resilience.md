# `fix(pr-workflow)`: closes four review-pipeline wedge states; integrity boundaries stay fail-closed

## Summary

A tracing pass over the PR_REVIEW / PR_FEEDBACK gate found five wedge states — durable conditions that were permanent until `abort_pr_workflow`, or worse, that defeated `abort_pr_workflow` itself. This change closes the four that were live (W-5 for schema-invalid-but-**parseable** state — unparseable bytes and unreadable identity still fail everywhere, deliberately), under one rule: **unavailability degrades with disclosure; contradiction fails closed.** A check that *cannot run* never wedges the workflow; a check that *runs and disagrees* still hard-fails exactly as before. The fail-closed integrity boundaries listed below remain exits-by-`abort` only where identity or attestation cannot be proven.

## Stuck lanes no longer block abort or completion

A lane whose background process died without ever writing a terminal snapshot counted as "in flight" forever. The same predicate gates `abort_pr_workflow`, the PR_REVIEW to PR_FEEDBACK transition, and `complete_pr_workflow` — so the escape hatch was refused by the very condition it exists to resolve, leaving the workflow with **no exit through any tool**.

- A lane whose delegation record has not advanced its `updatedAt` within 30 minutes is now **presumed stale** and settles instead of blocking. 30 minutes is the horizon the delegation subsystem already used; it is now a single exported constant (`DEFAULT_STALE_DELEGATION_TIMEOUT_MS`) shared by `dispatch-lanes.ts` and this gate's own timeout, rather than a value hardcoded separately in each. The `hooks.background_pending_timeout_minutes` schema default in `src/config/schema.ts` still carries its own hardcoded `30` and remains a separately-tunable operator knob, not yet unified with the constant.
- A lane with a **recent** `updatedAt` still blocks. A check that can run and reports "still progressing" is a contradiction, not an unavailability.
- Disclosure: `presumed_stale_lanes` / `presumed_stale_disclosure` on the `abort_pr_workflow` and `complete_pr_workflow` responses (present on the failure response too, since completion legitimately fails later on real coverage), a `pr_workflow_lanes_presumed_stale` record in `.swarm/events.jsonl`, and `presumedStaleLanes` on the existing `pr_workflow_aborted` audit event. The delegation record itself is durably transitioned to `stale`. This disclosure lists only the current session's `swarm-pr-*` lanes; the best-effort durability sweep it triggers is directory-wide with no session or mode filter, so it may also finalize other sessions' already-overdue `pending` / `running` delegation records. The sweep gains an optional status restriction and this caller passes `pending` / `running` only — the same two statuses the open-lane predicate counts — so it never finalizes a retryable `ingestion_error` record, whose transition to `stale` would be irreversible at the ingestion claim gate. The sweep's default scope is unchanged for its pre-existing lazy-maintenance caller. That sweep mechanism and its age horizon pre-date this change, but it had zero production callers before it — this change gives it its first production callers: abort, completion, and the PR_REVIEW-to-PR_FEEDBACK terminal-readiness check.

Staleness is decided by an in-memory read of the delegation ledger; the durable sweep runs afterwards only as a best-effort complement. That ordering is deliberate — the sweep swallows store-lock timeouts and returns zero, so making reachability depend on it would have re-created the same wedge under lock contention.

## A corrupted gate state no longer defeats abort

If the durable gate-state file failed schema validation, every reader threw — including the one `abort_pr_workflow` needs. Every field of the workflow became stuck simultaneously and the only repair was a manual filesystem edit, outside any exposed tool.

`abort_pr_workflow` and `pr_workflow_status` now read through a **dedicated recovery-only reader**. On a schema-validation failure with parseable JSON it salvages `sessionID`, `mode` and `prHeadSha`, plus `revision`, `prFeedbackReadyToPublish` and `checkoutRecovery` when each is individually well-formed, and discloses the schema errors verbatim (`stateSalvaged` / `stateSalvageDisclosure`). The general reader is unchanged, so no write, completion, or verification path can ever observe a salvaged projection, and a salvaged view is never cached.

Four boundaries deliberately did **not** soften:

- **Unparseable bytes fail everywhere**, recovery included. There is nothing to salvage and guessing would be fabrication.
- **Unreadable identity fails everywhere.** Without a readable `sessionID` and `mode` there is no provable subject to act on.
- **A present-but-unreadable `prFeedbackReadyToPublish` is treated as ARMED** and abort still refuses. Corrupting that one nested record must never become a way past the armed-abort refusal.
- **`complete_pr_workflow` still refuses a salvaged state**, unchanged.

When `revision` is salvageable the abort takes normal compare-and-swap, reading back through the same salvage-tolerant view. When it is not, the abort takes `clearPrWorkflowGateState`'s documented `expectedRevision === undefined` escape hatch — a deliberate, disclosed CAS drop, reported as `state revision unsalvageable; cleared without compare-and-swap`.

The abort audit record is appended before the CAS-guarded clear runs, so a losing compare-and-swap on a concurrent abort would otherwise leave a durable `pr_workflow_aborted` entry for an abort that never executed. The clear is now wrapped: on failure a best-effort `pr_workflow_abort_not_completed` record is appended to `.swarm/events.jsonl` — carrying the same `sessionID`, `mode`, and `prHeadSha` so it correlates with the original entry — and the underlying error is re-thrown unchanged, so caller behaviour and abort reachability are identical to before.

## The PR_FEEDBACK inventory is append-only instead of immutable

`declarePrFeedbackInventory` rejected any different array after the first declaration. A finding discovered later — or a misspelled id — had no mechanical repair: the only exit was `abort_pr_workflow` plus a full restart, which also discarded every completed verification for the items that *were* declared correctly.

Re-declaring with **additional** items is now accepted. Every previously-declared entry must still be present, so mutation and removal still hard-fail (`inventory is append-only after declaration`). Note that the inventory is canonicalised by sorting and rejects duplicates, so an appended id lands in sort position and reordering is not expressible at this boundary; the acceptance rule is therefore set-superset rather than array-prefix.

What an amendment costs and preserves:

- Completed **verification** batches for the original items are preserved. Cover the appended item with a new verification batch owning just that item.
- Stage A must be re-recorded over the full amended inventory, and each ordered gate phase re-run with a lane owning every current inventory item. `assertPrFeedbackGatePhaseSettled` now re-checks batch ownership against the *current* inventory at settle time. This is the load-bearing control: gate-batch retention compares only the revision digest, categories and obligations — never the item list — so without it an amendment plus a same-revision Stage A re-record would retain batches whose ownership predates the growth, and the appended item would reach publication with **zero Stage-B verdict**.
- An amendment disarms publication, because the armed record attested coverage of the pre-amendment inventory. Re-arm with one `complete_pr_workflow` call. This mirrors the unconditional disarm a Stage A re-record already performs.
- Every appended entry is recorded in an audit ledger, surfaced as `inventory_amendments` on the completion response and `inventoryAmendments` on `pr_workflow_status`. The ledger is bounded at 128 entries and is never pruned — it is an audit trail, not a reclaimable cache — so further amendments are refused at the cap rather than compacted.

## Transient revision-digest failures are retried, never faked

`write_pr_review_trigger_eval` bound the current exact revision digest with a single bounded git read. One transient timeout under host contention ended the whole trigger evaluation, and the failure message named neither the cause nor a recovery path.

The resolution is now retried **once** (two attempts, never a spin loop), and the failure message enumerates the collapsed null causes and the recovery options.

There is deliberately **no fallback here**, and this is the one place the degradation rule does not apply. Unlike the merge-base check — which degrades to a durably-bound, bind-time-verified review scope — PR_REVIEW has no independently-bound durable revision digest to fall back to: the gate-state digest fields belong to PR_FEEDBACK, and the only durable copies of a PR_REVIEW revision digest live on the very lane artifacts the evaluation is validating. The lane-output store additionally declares `revisionDigest` optional, so a set-comparison fallback would convert today's fail-closed `undefined !== digest` into a passing `undefined === undefined` and let a lane artifact self-certify its own revision. A regression test asserts that a digest-null does **not** succeed, specifically to fail if a fallback is ever reintroduced.

## Two related reports investigated and found already resolved

- **Severity split-brain between the findings writer and the candidate contract** — not live on current `main`. `write-pr-review-artifact.ts` validates `severity` with `z.enum(CANDIDATE_SEVERITIES)`, the same constant the candidate contract exports, so the two cannot disagree. No change made.
- **Claude-adapter dead end when the swarm controller tools are absent** — not live on current `main`. The `.claude` adapter states that a plain Claude Code session having no controller tools "is canonical Profile B, not an error", instructs the agent never to report BLOCKED merely because they are absent, and scopes the Profile A instructions to sessions that actually expose `dispatch_lanes_async` / `collect_lane_results` / `retrieve_lane_output`. No change made.

## Operator documentation

The canonical `swarm-pr-review` skill's "Aborting an unrecoverable review" section no longer claims that in-flight lanes block abort unconditionally, and `references/lane-output-recoverability.md` gains a gate-level recovery section covering all three behaviours above, including the boundaries that stayed fail-closed.

## Breaking changes

None. `prFeedbackInventoryAmendments` is optional on the gate-state schema and that schema is passthrough, so state written before this change reads unchanged and a rollback preserves the field opaquely rather than refusing the file.

## Known caveats

- Settling a presumed-stale lane writes a `pending`-to-`stale` transition to the delegation store from the abort path, which was previously read-only with respect to that store. That transition is already ordinary operation for this store, and the write is best-effort: abort's reachability does not depend on it.
- An inventory amendment does not preserve already-recorded ordered-gate batches. Preserving them and requiring fresh coverage for appended items are mutually exclusive here, because each gate batch must own the whole inventory exactly once; coverage was chosen. This is still strictly better than the previous only exit, which discarded the verification batches too.
- **Staleness is age-first, and a settled lane's work is unrecoverable.** Nothing heartbeats a delegation's `updatedAt` — it advances at record creation and at the single `pending`-to-`running` transition, never during the work itself. So "has not advanced its `updatedAt` within 30 minutes" means "has not changed status in 30 minutes", not "is not making progress"; and because a settled record is terminal and the collector skips it, its transcript is never fetched and its work must be re-dispatched. Issue #2251 has since added a **fail-open liveness probe** in front of that decision: a lane past the horizon whose session the host affirmatively reports as `busy` or `retry` is retained instead of settled. The probe never *creates* a wedge — an unavailable, erroring, timing-out or empty probe settles exactly as before — so the reachability floor this change established is unchanged. What remains true is that a lane the probe cannot vouch for is still presumed stale on age alone, and its work is still lost.
- Found while resolving issue #2242.
