# fix(workflow): settled background coder settlements justify Stage-A recovery

## What

Closes the task 2.14 wedge from a consumer project's
`.swarm/swarm_communication_debug.md` (2026-11-26, consumer-project):
a background-dispatched coder round ran to a completed terminal, settled its
coder settlement, and was durably consumed with ingestion outcome
`accepted` — while attributing ZERO files, because the deliverable had
landed outside the delegation lane (the user salvaged and committed it
after a liveness-stale predecessor round). For that verification-only
shape neither existing Stage-A recovery receipt exists: background
dispatches never COMMIT a settlement WAL (the legacy WAL is always retired
ABORTED-by-transfer when ownership moves to the durable background
completion), and no `accepted_mutation` requirements receipt is written
because nothing mutated. `recover_stage_a_task` and the `/swarm recover`
scan therefore refused forever with `RECOVER_STAGE_A_SETTLEMENT_REQUIRED`
while retry dispatches just re-settled `dispatch_no_mutation` — the task
wedged at `idle` with no agent-legal exit.

`resolveStageASettlementJustification` gains a third receipt form:
a **settled background coder settlement whose completion was durably
consumed with ingestion outcome `accepted`**. Only `accepted` justifies —
`rejected`/`skipped`/`stale` are the platform's own refusals of that
completion, and a still-pending ingestion claim has not established the
fact (the terminal-closeout reconciler will). The audit events surface
`accepted: false` (the verification-only shape) plus the correlationId so
the audited recovery vouch is informed, and the remediation texts of both
recovery surfaces name all three receipt forms. Also carries the minimal
r14 ingestion-outcome backport from upstream 7.205.9 (type, schema field,
atomic write) — identical shape to upstream, trivial to drop on merge.

## Why

The settlement receipt is what distinguishes the settlement-backed
Stage-A wedge from a not-yet-started or deliberately stopped task. The
settled+accepted background delegation record is the same durable
settlement fact for the background era — without it, every verification
round whose deliverable predates its dispatch (manual salvage, campaign
rebuild, stale-predecessor recovery) locks the task out of Stage A with no
sanctioned path at all.

## Verification

New suite
`tests/unit/workflow/stage-a-background-settlement-justification.test.ts`
5/5 (supervised repair + `/swarm recover` scan repair, `accepted: true`
mutation-attributed shape, rejected-ingestion fail-closed, green-bundle
bar); touched suites 71/71; store/ingestion suites 47/47; `tsc --noEmit`
clean; deployed and exercised in the consumer's production build the same
day (task 2.14 recovered via `recover_stage_a_task`, justification
`background_settlement`, `accepted: false`).
