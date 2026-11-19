---
title: "PR-feedback dispatch integrity: stateless rejections and the stage-b-test verdict clause"
description: "Verification requests rejected for inventory/ownership shape consume no gate state; unlaunchable base/micro agents are refused before activation; stage-b-test lanes get the [TESTED] mandate suspension"
type: fixed
---

## What changed

- **PR_FEEDBACK verification rejections stop consuming gate state** (#3644 AC1): a
  `swarm-pr-feedback:verification` request whose lanes own an item not in the
  requested inventory (or doubly-claim an item) is now rejected by a request-pure
  shape check that runs BEFORE any state mutation — before PR_FEEDBACK activation on
  a fresh session and before the append-only inventory declaration on an active one.
  Previously the typo'd inventory was persisted first, so the corrected retry was
  wedged by the append-only rule ("may not be removed or renamed"). The stateful
  predicates (duplicate batch id, capacity, cross-batch ownership) are unchanged.
- **Unlaunchable base/micro lane agents are refused before activation** (#3644 AC2):
  base and micro admission now runs the same `validateLaneAgent` launchability probe
  the lane launcher uses (including the bare-canonical-role registry refusal on
  prefixed-only multi-swarm hosts), so such requests no longer activate the workflow
  and bind/record state before launch rejects them. The set of rejected requests is
  unchanged — only the durable-state consumption moves.
- **stage-b-test lanes carry the verdict-mandate suspension clause** (#3645): the
  fourth ordered PR-feedback gate now gets the same controller-authored PROTOCOL
  SELECTION clause the other four gates have, suspending the test_engineer prompt's
  task-keyed `[TESTED]` "STRUCTURED VERDICT LINE" mandate in favor of the gate's
  item-keyed `[STAGE-B-TEST] | <item_id> | PASS` settlement rows — closing the same
  conflict class that voided reviewer lanes before the clause mechanism existed.

- **Both #3752 residual paths are fixed in this PR** (maintainer decision, option
  (b)): a verification dispatch rejected for a STATEFUL reason after an inventory
  amendment (duplicate batch id, capacity after prune, cross-batch exclusivity)
  no longer persists the amendment — the dispatch path runs
  `declareAndEnforcePrFeedbackVerification`, a single-bind/single-write
  transaction, so the corrected retry is never wedged; and every recognized
  PR_FEEDBACK lane mode (verification + the four ordered gates) probes agent
  launchability at the admission site before any gate record is written.

## Why

Follow-ups from PR #3632's post-delivery breadth review (closure-ledger rows FB-010
and closeout MEDIUM-1): two state-consuming rejection paths and one unsuspended
static verdict mandate survived the dispatch-integrity pass.
