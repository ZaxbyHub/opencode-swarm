# fix(gate): a scope-prep refusal no longer counts as a coder retry failure

## What

Closes the task 2.16 retry-circuit wedge from a consumer project's
`.swarm/swarm_communication_debug.md` (2026-11-26, Wirtschaftssimulation).
The delegation gate's `prepareCoderScope` catch wrote a
`dispatch_no_mutation` retry-accounting transition for EVERY
scope-preparation error — even though a refused dispatch never ran a
coder. Gate-side refusals therefore self-escalated the retry circuit:
observed live, one real provider-budget abort (`ExceededBudget`, an
account-level resource event) plus two refused dispatches reached the
bounded retry threshold, demanded a critic consultation, and burned the
critic-guided simplified retry with another refusal — the task wedged at
`TASK_RETRY_USER_ESCALATION_REQUIRED` with no coder attempt in between.

The catch now writes ONLY through the explicit empty-plan-scope
settlement (the designed read-only dispatch flow, #2763/#3560 —
unchanged); every other scope-prep refusal leaves `retryCount`,
`retryHistory`, `lastOutcome`, and the transition chain untouched. The
escalation ladder itself is unaffected: `enforceCoderRetryEscalation`
runs on every dispatch attempt BEFORE the scope preflight with its exact
semantics.

## Why

A gate refusal is not a dispatch failure. Counting refusals as coder
retry failures makes every repeated refusal more likely to be refused
(the counter the refusal inflates is the counter that gates the next
attempt) — a guaranteed escalation spiral for any task that trips the
threshold once, with the critic consultation and the single
critic-guided retry consumed by dispatches that never ran.

## Verification

New suite
`tests/unit/hooks/delegation-gate-scope-refusal-no-retry-count.test.ts`
2/2 — falsified against the pre-fix code (2/2 fail on the prior HEAD:
the refusal pushes `retryCount` 2→3 and rotates
`lastOutcome`/`lastTransitionId` to its own `coder-preflight` marker;
with the fix: untouched, and five repeated refusals neither spiral the
counter nor emit any `coder_retry_circuit_breaker` event).
Empty-scope settlement + scope-preflight suites 23/23;
retry/sounding-board/escalation suites 16/16; `tsc --noEmit` clean;
`biome` clean. Deployed to the consumer's production build the same day.
