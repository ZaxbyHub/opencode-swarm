---
issue: '3341, 3337, 3362'
---

# PR-review lane dispatch integrity: side-effect-free admission, controller-scoped protocol clauses, fail-closed severity derivation

Closes #3341, closes #3337, closes #3362 (user-authorized collated delivery).

## What changed

- **State-free rejections no longer consume durable workflow state (#3341).** The
  state-free admission checks now run in `validatePrWorkflowLaneAdmission` BEFORE
  `activatePrWorkflow`/`bindPrReviewBase`: lane roles, owned-workflow-lane shape,
  agent launchability for critic/reviewer/council phases (base/micro discovery lanes get only the explorer-role check here; their launchability is still checked at launch, after activation, as before),
  the contract-retry exclusion, the wave-stage/attempt pairing, and
  unknown `swarm-pr-review:*` suffixes. A request rejected by these checks
  creates no gate state and leaves pre-existing gate state structurally unchanged (parsed state deep-equal). Checks that
  need gate state or resilience config (tier-dependent lane count and
  max_concurrent, canary-first and fanout order, trigger evaluation,
  swarm-pr-feedback:verification ownership) still run after activation and are
  not covered by this guarantee. Previously an unlaunchable critic batch left the PR_REVIEW gate
  activated and base-bound.
- **Prompt-structure overrides are controller-authored, not prompt-content
  triggered (#3337).** The critic agent's static prompt no longer carries a
  PR-review override that activated when the model judged the literal phrase
  "CONTROLLER-BOUND PR WORKFLOW CONTRACT" present — any plan or spec quoting
  the phrase satisfied that predicate. The dispatch controller now composes a
  mode-scoped protocol clause into the lane's contract block for ALL SIX
  consumer modes (swarm-pr-review critic/reviewer and the three ordered
  PR_FEEDBACK gates and the verification lane), the same proven channel reviewer lanes have used since
  #3310, with an explicit authority line naming precedence over the agent's
  default output structure. The reviewer prompt's literal-phrase Stage-B
  exception is gone; non-workflow reviewer and critic behavior is unchanged.
- **The critic preflight reads the fail-closed authoritative gate (#3362).**
  `derivePrReviewReviewerSeverities` and `derivePrReviewOrderUnstableItems`
  route through `authoritativeReviewerClaims`: an UNCOVERED reviewer phase now
  yields an empty severity map and no order-unstable ids — including
  invalidating stale critic-batch coherence stamps — instead of leaking
  partial state that annotates items the binder would refuse. Under an
  admitted N-of-M settlement the surviving actual claims are retained.
- **Adapter docstring truth + complete pins (#3362).** The
  `verdictRowsContainOnlyAssignedIds` docstring now states the real split
  (missing and legal-arity duplicates remain per-item parse failures;
  illegal-arity duplicates are quarantined with the valid sibling keeping the
  claim), and the duplicate/overflow behavior set is fully pinned, including
  the quarantined recovered-overflow zero-recovery side.
- **The null-prototype severity lookup is pinned (#3362).** The construction
  moved into `ownPropertySeverityLookup` (exported via `_test_exports`) and a
  behavioral pin proves a prototype-key item id without a settled severity
  renders bare.

Note: #3362's operator-prompt lint sub-claims (the fullwidth-space lint and
variant pins) were verified ALREADY FIXED at this branch's base by the #3335
wave and are PRESERVED by this change (frozen PRESERVING checks), not
re-implemented.
