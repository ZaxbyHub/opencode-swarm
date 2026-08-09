# PR workflow gate accounting: composable settlement, per-item critic retention, bounded retries

Fixes issue #1968: the PR-workflow gates previously treated the entire
inventory on the current revision as the atomic unit of validity, so every
local failure — one lane, one dimension, one feedback item — forced global
rework with no bounded recovery path.

## What changed

- **Reviewer and critic settlement now compose across batches, item by
  item.** A reviewer or critic phase settles once every review item in the
  current inventory holds a successful verdict, whether that coverage comes
  from a single batch or from several complementary partial retries. One
  failed lane in an otherwise successful batch no longer forces every item —
  including the ones that already passed — to be re-run. When more than one
  successful batch covers the same item, the most recent successful batch
  wins that item, and this conflict rule is the single computation shared by
  settlement and every downstream verdict use, so they can never disagree
  about which claim is authoritative.
- **The critic gate can no longer be skipped silently.** The gate that
  decides whether critic coverage is required at all now fails closed if the
  reviewer phase is not settled, or if a settled reviewer phase somehow
  yields an empty or incomplete verdict map. Previously either condition
  produced an empty critic inventory, which read as "nothing needs a critic"
  and let confirmed critical/high findings ship unchallenged, surfacing only
  as a later, misleading "no authoritative reviewer verdict" error. Both
  conditions now block with a message naming the actual cause.
- **Critic evidence is retained per item, not per batch.** A critic claim is
  bound to the exact reviewer row it was validated against. A reviewer retry
  that reproduces a byte-identical row for an item keeps that item's critic
  work; a reviewer row that changed at all invalidates only that item's
  critic claim, not the whole critic wave. Critic batches recorded before
  this per-item binding existed keep the prior behavior: a newer reviewer
  batch still invalidates them wholesale.
- **Tier-L base retries no longer require a full six-lane singleton
  fan-out.** A retry may consolidate dimensions that each have a recorded,
  terminally-failed prior attempt and currently lack a successful source. Two
  lane floors bound how much depth consolidation may cost: no single lane may
  own all six dimensions, and — measured cumulatively across every recorded
  base batch, not per batch — the six dimensions must stay backed by at least
  four distinct lanes, counting each dimension no consolidated lane claims as
  one, plus the *fewest* of the declared consolidated lanes that together cover
  every dimension consolidated lanes do claim. That floor counts a minimum
  cover rather than declarations because declaring a lane costs nothing: the
  four pairwise consolidations `{A,B} {B,C} {D,E} {F,A}` are each individually
  legal, but three of them already cover all six dimensions, so the wave would
  settle at three producing lanes and is rejected — a count of declarations
  would have read four and accepted it. In practice that permits a
  single two-dimension consolidation, or two of them, and rejects a wholesale
  re-do of the wave in two or three lanes even when it is split across
  batches. A dimension that already has a successful source, or whose prior
  attempt is still in flight, still requires its own dedicated retry lane, and
  a full singleton re-dispatch of the whole wave is always available. The full
  fan-out requirement on the initial base wave is unchanged.
- **The PR_REVIEW batch limits are no longer a dead end.** Sessions that
  accumulate a large number of base or validation batches now garbage-collect
  provably inert ones instead of being permanently blocked once the limit is
  reached. A reviewer batch is dropped only when a full-window recomputation
  shows it contributes no verdict claim; council and critic batches, the newest
  batch of each phase, and any base batch carrying a fully successful lane are
  never dropped. Pruning never changes the computed candidate or critic
  inventory, never un-forbids a reviewer's child session for the critic reuse
  ban, and never hands a tier-L wave back consolidation budget it already
  spent — a dropped base batch's consolidated lane sets move to a retired
  ledger the cumulative lane floor keeps walking, so that floor is invariant
  under the GC. Both ledgers are bounded, and a prune that would overflow
  either one keeps every batch instead of dropping a forbidden child session
  or a spent consolidation. The prune runs inside the same
  read-prune-append-persist transaction as the batch that triggered it, so
  there is no separate, interruptible GC write.
- **The PR_FEEDBACK verification batch limit is no longer a dead end either.**
  Verification batches accumulate on retry just as the PR_REVIEW arrays do, so
  the same reclaim applies. Settlement coverage comes only from lanes that both
  passed batch integrity and produced an artifact covering their items, so a
  verification batch whose every lane failed contributes no coverage; what it
  does hold is its item→lane ownership binding, and those bindings are moved to
  a retired ledger so the cumulative re-claim rejection — an item may never be
  re-claimed by a *different* lane — stays in force across the prune. The
  newest batch is never dropped, the covered-item set is proven unchanged, and
  a ledger overflow keeps every batch instead.
- **PR_FEEDBACK Stage A re-recording on an unchanged revision retains
  already-approved gate evidence.** Re-recording Stage A still always
  requires a fresh, complete receipt set on the current revision digest. But
  if the revision digest did not change and the newly declared applicable
  obligations/categories are equal to or a superset of what was previously
  declared, the already-approved Stage B and closeout gate batches are
  retained instead of being wiped. A narrower obligation set, or any actual
  digest change, still wipes every gate batch and un-arms publication exactly
  as before.
- **PR_FEEDBACK's revision-digest computation supports larger diffs with
  diagnosable limits.** The file-count and byte-size caps that bound digest
  computation, and the buffer that bounds the underlying `git diff`/`git
  status` enumeration, were raised together — raising the file cap alone
  would have been inert, since the enumeration buffer could still overflow
  first. When a diff still exceeds a bound, the resulting BLOCKED message now
  names the specific bound that was exceeded (file count, byte size, buffer
  truncation, timeout, a failed git invocation, or a containment violation)
  instead of an undifferentiated failure, and truncation is distinguishable
  from an outright cap.

## Why

The reviewer/critic path enforced settlement as an all-or-nothing property of
each batch, while the PR-review base-coverage path already unioned successful
dimensions across batches with no such requirement — the same defect class
that motivates this change was already fixed once, just not consistently.
Retrying one failed lane, one failed dimension, or one unresolved feedback item
should not force revalidation of the sibling work that already passed on the
same revision — including feedback items already closed. Retention is scoped to
an unchanged revision digest, so a subsequent edit still invalidates everything;
the improvement is to the same-revision retry, not to the edit-then-retry case
(see the design decision below). Composable, item-keyed accounting closes
that gap while keeping the underlying independent-review contract — an
`unclaimed` item still blocks completion, and a batch can only contribute
verdicts for the exact inventory it was validated against.

## Design decision: PR_FEEDBACK gate evidence stays batch-scoped, not item-scoped

Stage A, Stage B, and closeout gate evidence for PR_FEEDBACK still invalidate
as whole gate batches, not per feedback item. This is a deliberate decision:

- The file scope a caller declares for a feedback item is caller-asserted and
  only path-sanitized — it is never intersected with the actual changed-file
  set, and carries no persisted binding back to feedback item IDs. Keying
  invalidation on that declaration would let a controller dodge
  re-verification by under-declaring scope, turning a fail-closed guarantee
  into a fail-open one (the same failure class that already ruled out keying
  digest invalidation on `git diff --raw` blob OIDs).
- The four PR_FEEDBACK gate phases are holistic by contract: each batch must
  own every inventory item exactly once and in declared order. Per-item
  retention would re-partition that independent-review contract itself and
  would need its own collusion/independence analysis before it could be
  trusted.

## Migration and compatibility

All new persisted gate state is additive: four optional top-level keys on the
existing non-strict PR-workflow gate schema (`prReviewBatchCoherence`,
`prReviewRetiredReviewerSessionIds`, `prReviewRetiredConsolidatedLanes`, and
`prFeedbackRetiredItemOwnership` — the last three written only by a capacity
GC), plus a per-item binding map on critic batch records. A rolled-back plugin
parses the newer state without
error and simply ignores the new fields; PR-workflow gate state is
per-session and cleared at completion, so there is no cross-version data
migration to run.
