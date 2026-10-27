# PR-review gate-side critic admission and PR_FEEDBACK closeout-critic role parity

## What

Issue #3340. The PR critic-role rule (issue #3310: only the `critic` agent may
run `swarm-pr-review:critic` lanes, because the other critic-family agents
return strict-JSON dispositions instead of verdict rows) is now enforced at the
gate boundaries that persist and settle verdict batches, and the PR_FEEDBACK
closeout-critic predicate is aligned with it.

- `recordPrReviewValidationBatch` (`src/hooks/pr-workflow-gate.ts`) rejects any
  critic-phase lane whose declared agent does not resolve to exactly `critic`.
  Lane specs now carry the declared `agent` (`PrWorkflowLaneSpec.agent`,
  persisted on the batch record and allowed by the state schema); a critic lane
  that declares no agent fails closed. The dispatch caller threads
  `lane.agent` and its generated-agent-name registry through, so the gate's
  verdict is identical to the dispatch admission verdict, including for
  multi-swarm prefixed names such as `mega_critic`.
- `analyzeLaneArtifactIntegrity` (`src/hooks/pr-workflow-gate.ts`) asserts that
  a `swarm-pr-review:critic` child delegation record ran the `critic` role
  (new failure predicate `record.normalized_agent`), instead of only checking
  that the artifact role matches the record. `normalizedAgent` stores the
  resolved canonical role at launch, so prefixed critic agents still settle.
- PR_FEEDBACK closeout-critic (decision recorded for AC2): the role must be
  EXACTLY `critic`. The dispatch predicate
  (`src/tools/dispatch-lanes.ts`, `swarm-pr-feedback:closeout-critic`) and the
  settle-gate session check (`assertIndependentFeedbackGateSessions`) no longer
  accept `critic_`-prefixed roles. Rationale: the closeout gate settles on one
  `[CLOSEOUT-CRITIC]` verdict row per feedback item — the same row-emission
  contract the other critic-family agents cannot produce.

## Why

The reviewer audit of PR #3329 confirmed the critic-role rule lived at a single
dispatch call site: the gate recorder accepted any lane spec for a critic batch,
the artifact integrity check never asserted the role, and the PR_FEEDBACK
closeout admitted any role starting with `critic` (classified PRE_EXISTING
INFO; the #3310 fix had deliberately scoped its tightening to PR_REVIEW). One
rule now holds at every boundary: only the `critic` agent may emit critic
verdicts.

## Migration

- PR_REVIEW critic dispatches that already use the `critic` agent (or a
  prefixed generated name whose canonical role is `critic`) are unaffected.
- PR_FEEDBACK `swarm-pr-feedback:closeout-critic` dispatches that used another
  critic-family agent (for example `critic_oversight`) are now rejected with
  `BLOCKED: PR_FEEDBACK closeout-critic requires workflow_lane "closeout-critic"
  and role "critic"`. Re-dispatch the closeout-critic gate with the `critic`
  agent.
- Previously persisted gate state remains readable: the new `agent` field is
  optional in the batch-record schema and is only asserted when a critic batch
  is recorded, never on read-back of older state.

## Caveats

- The record-time assertion validates the caller's declared agent; the
  settle-time artifact assertion independently validates what actually ran.
  A direct gate caller that omits `generatedAgentNames` gets suffix-based role
  resolution, which is marginally more permissive than dispatch admission for
  unregistered `*_critic` names — dispatch still rejects those names first on
  the production path.
- Existing PR_FEEDBACK workflows recorded before the upgrade that already
  settled a closeout-critic lane with a critic-family role are not re-validated;
  only new settlements are checked.
