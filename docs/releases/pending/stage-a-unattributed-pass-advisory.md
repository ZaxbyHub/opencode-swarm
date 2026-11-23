# `fix(guardrails)`: a green but unattributed `pre_check_batch` now says so instead of silently wedging Stage A

## Summary

- A `pre_check_batch` run that **passes** while its result cannot be attributed to any task (route `no_task_correlation`) was a completely silent no-op: the tool output reported `gates_passed: true`, the bounded route event was recorded, but no Stage A evidence was written and **no advisory, warning, or output hint** reached the architect. The wedge was discovered only much later, when the Stage B dispatch failed with `TASK_WORKFLOW_STAGE_A_REQUIRED` — and every advertised remediation (`/swarm recover <task>`, `recover_stage_a_task`) then refused too, because the wedged task's coder round was background-dispatched and wrote no settlement WAL. The architect burned a verification round, a settlement-round attempt, tripped the retry circuit (`TASK_RETRY_USER_ESCALATION_REQUIRED`), and had to escalate to the user — exactly the observed Wirtschaftssimulation task-1.13 deadlock.
- Root cause: in `toolAfter` (`src/hooks/guardrails/index.ts`), the uncorrelated-pass branch emitted only the fail-open route event. The sibling failure modes already communicate — `attribution_ambiguous`/`unbound` emit a `STAGE A ATTRIBUTION …` advisory at `toolBefore` time, and transition-write failures push `STAGE A WRITE FAILED` advisories — but the plain "no correlation at all" pass said nothing, because a pass *looks* like success.
- Fix: when a `pre_check_batch` **pass** verdict completes with no task correlation (route `no_task_correlation`), the hook now pushes a visible, cooldown-gated, session-bounded advisory via the existing `emitDurableAttributionAdvisory` channel:

  > `STAGE A RECEIPT NOT ATTRIBUTED: pre_check_batch passed but the result could not be attributed to any task — no session task correlation (in-memory state wiped by a restart or reset) and no durable settlement candidate (background-dispatched coder rounds write no settlement WAL). … Remediation: dispatch a coder round that performs a real in-scope mutation (its accepted settlement re-arms attribution), then re-run pre_check_batch. If this was an ad-hoc gate run with no task in flight, no action is needed.`

- Deliberately unchanged: the fail-open attribution semantics (the receipt is still dropped, never guessed), the closed seven-route vocabulary and route-event shape, the `attribution_ambiguous` path (keeps its own more specific toolBefore advisory — no double-advising, pinned by test), and fail verdicts (a failing batch already communicates through its own visible output; nothing success-looking is silently lost, pinned by test).

## User-facing changes

- After a host restart or `/swarm reset-session`, an architect who re-runs `pre_check_batch` for a task whose in-memory correlation is gone now sees immediately — in the same turn, not at the next reviewer dispatch — that the green result was **not** recorded as Stage A evidence, why Stage B will be denied, and which remediation actually works for the no-settlement wedge class (a real coder mutation round, not `/swarm recover`).
- Ad-hoc gate runs without any task in flight see the same advisory once (60 s cooldown, keyed per session+directory) with an explicit "no action needed" carve-out.

## Migration notes

None. No on-disk format changes; the advisory rides the existing bounded advisory queue (invariant 8: session-keyed, cooldown-gated, capacity-bounded).

## Discovery context

Found in the Wirtschaftssimulation loop (session `007e6133-aafc-4474-ad51-aa93210a3031`, task 1.13): after a mid-session server restart, `pre_check_batch` ran green twice on the committed `3a7db10` deliverables while `check_gate_status` kept reporting `Missing gates: pre_check` with the workflow at `idle`/generation 0; the reviewer dispatch was denied (`TASK_WORKFLOW_STAGE_A_REQUIRED`), `recover_stage_a_task` refused (`RECOVER_STAGE_A_SETTLEMENT_REQUIRED` — background dispatches write no settlement WAL), the user-run `/swarm recover 1.13` changed nothing, and the retry circuit finally demanded user escalation. Pinned by `tests/unit/hooks/guardrails-stage-a-route-events.test.ts`: the unattributed-pass advisory fires in both guardrails modes (content asserts the `TASK_WORKFLOW_STAGE_A_REQUIRED` consequence, the no-settlement-WAL cause, and the remediation), an unattributed fail stays advisory-silent, and the `attribution_ambiguous` unbound shape does not double-advise.
