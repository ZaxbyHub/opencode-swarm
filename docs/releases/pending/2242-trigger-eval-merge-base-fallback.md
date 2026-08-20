# `fix(pr-review)`: unwedge PR_REVIEW completion when merge-base re-verification is transiently unavailable

## Summary

- `write_pr_review_trigger_eval` re-derived the review merge base at write time and treated a `null` result as **refutation**. `resolveExactMergeBase` returns a bare `null` for a timed-out git call, a git process that failed to spawn, an unresolvable `base_ref`, and a ref rejected as an unsafe revision token alike — so *unavailability* was indistinguishable from *disagreement*.
- Because that check gates the durable trigger-eval receipt, a transient failure blocked the whole review permanently: the receipt was never written, `complete_pr_workflow` stayed BLOCKED, an omission dispatch could not repair the state, and the only exit was `abort_pr_workflow`. Every retry re-failed identically.
- The writer now resolves the merge base through the **async** twin (`resolveExactMergeBaseAsync`) instead of a blocking `spawnSync` on an async tool path — the same non-blocking treatment the revision-digest seam in this file already had, and one contributing cause of the 3 s timeouts.
- When live re-derivation is unavailable **and** the supplied `base_ref`/`base_sha` exactly equal the review scope already bound durably at dispatch, the writer proceeds and discloses `base_verification: bound_fallback`. The bound scope is not a weaker fact: it was derived by a real `git merge-base` at dispatch time and only trimmed/lowercased on the way into durable state, so the write-time re-check is redundant re-verification, not the origin of the fact.
- An explicit unbound guard now fails closed *before* resolution when the gate carries no bound `base_ref`/`base_sha`, so the fallback is safe by construction rather than by accident.

## User-facing changes

- Every new v2 receipt and every successful tool result now carries `base_verification: "live" | "bound_fallback"`. `live` is the normal path.
- A `bound_fallback` write also emits an always-visible `CRITICAL-WARN` naming the ref, the head, and the bound scope it proceeded on.
- `bound_fallback` is recorded on the durable receipt, returned in the tool success payload, and emitted as the always-visible warning above. Synthesis/report disclosure is skill-directed (not machine-enforced by the workflow gate, unlike `coverage_degradations` which the gate reads as a waiver filter). The canonical `swarm-pr-review` skill documents this obligation in `references/lane-output-recoverability.md`.
- The same reference file now spells out the dispatch-vs-writer provenance split: inline `trigger_evaluation` rows carry only `trigger_id`/`result`/`evidence`, while `source_batch_id`/`source_lane_id` belong only to the writer's `rows`. That ambiguity produced the incident session's first-dispatch confusion.

## All mismatch paths remain fail-closed

The fallback narrows nothing:

- Live resolution succeeds but disagrees with the claimed `base_sha` → unchanged hard failure (`merge-base mismatch`).
- Live resolution succeeds and matches, but the scope disagrees with the durably bound scope → unchanged hard failure (`scope mismatch`).
- Live resolution unavailable **and** either half of the supplied scope differs from the bound scope → hard failure, now with an enriched message enumerating the collapsed null causes and the recovery options (verify both revisions with `git rev-parse`, retry once the environment settles, or restart with `abort_pr_workflow` kind `"recovery"`).
- Gate carries no bound base at all → hard failure before resolution is attempted.

The reviewed range stays SHA-scoped (`base_sha...pr_head_sha`) on both paths, so what was reviewed is identical.

## Migration notes

No action required for the forward direction. `base_verification` is optional on the v2 receipt schema, so v2 receipts written before this change keep parsing unchanged, and historical unversioned and `schema_version: 1` receipts are untouched — the shared receipt envelope was deliberately **not** modified, precisely because widening it would change how legacy receipts parse and could reintroduce the same permanent-block class on the legacy path.

The reverse direction does require awareness: the writer now always emits `base_verification` on every v2 receipt, and `V2ReceiptSchema` is `.strict()`, so a rollback to pre-change code — or any stale reader process still running that code — cannot parse a receipt written after this change; `V2ReceiptSchema.parse` throws on the unrecognized key. The blast radius is narrow: the only in-repo reader of this receipt (`pr-workflow-gate.ts`) ships together with the writer in the same change, `abort_pr_workflow` and `pr_workflow_status` do not read the receipt at all, and the receipt is scoped per-run under `.swarm/pr-review/<run_id>/`. Recovery for a mismatched-version reader is the same as any other unparseable receipt: `abort_pr_workflow` followed by re-dispatch.

## Breaking changes

None for consumers upgrading in place. A downgrade/rollback of just this component while a receipt written by the new writer already exists is breaking for that one receipt: the pre-change `.strict()` schema rejects the new `base_verification` key. See Migration notes for scope and recovery.

## Known caveats

- On the `bound_fallback` path only, post-bind movement or deletion of the base ref escapes staleness detection — that is the one signal the live re-check provides. It is accepted deliberately and always disclosed (durable receipt + tool payload + `CRITICAL-WARN` + required report disclosure).
- The bound-scope equality property assumes durable-state integrity. An attacker who can write `.swarm` can forge the receipt directly, so this adds no attack surface, but it is not a defense against that attacker either.
- Found while resolving issue #2242 (RC-B / WP-1).
