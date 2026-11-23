# `fix(tools)`: a green pre_check_batch reconciles a mis-settled background coder completion and un-wedges Stage A in the same gate run

## Summary

- The directory-scope attribution fix (separate fragment) corrects **future** background coder completions, but tasks already mis-settled by the pre-fix bug stay wedged: the workflow holds `dispatch_no_mutation` as its last transition although the coder's real changes sit in the working tree, so `stage_a_passed` is refused from `idle` forever — and the architect's only sanctioned paths (fresh coder round, human-only `/swarm recover`) were not being taken, deadlocking the loop across sessions.
- Fix: the tool-side Stage A self-report now detects the exact wedge shape on a green gate run — last workflow transition is a `background-coder:*` `dispatch_no_mutation` while the task sits at `idle` — and reconciles it: it re-derives the delegation record's changed-file attribution with the fixed directory-aware predicate, records the `accepted_mutation` the completion should have carried (`background-coder-reconcile:<correlationId>`, same generation), and then records `stage_a_passed` in the same gate run. A `STAGE A RECONCILED` advisory tells the architect exactly what happened.
- Safety: reconciliation only fires for the **latest** delegation record of the task (a later dispatch owns the working tree), only when the re-derived attribution is non-empty, and is fully fail-open. A read-only round genuinely without changes does not reconcile (attribution stays empty); the generation cursor makes the repair idempotent (after the reconcile the last outcome is `accepted_mutation`, so the trigger no longer matches).

## User-facing changes

- A task wedged by the pre-fix directory-scope mis-settlement heals on its next green `pre_check_batch`: the accepted mutation is recorded, Stage A passes, and the Stage B reviewer dispatch is admissible again — no fresh coder round, no `/swarm recover`, no user action.

## Migration notes

None. The reconcile transition is a normal `accepted_mutation` (generation-rotating, audited); no on-disk format changes.

## Discovery context

The Wirtschaftssimulation task-1.13 loop after the directory-scope fix was deployed: the architect (context-critical, plan in `.swarm/context.md`) went straight to the reviewer dispatch, which still failed with `TASK_WORKFLOW_STAGE_A_REQUIRED` because the EXISTING workflow state (idle/gen 1, `lastOutcome: dispatch_no_mutation` from the settlement round's real two-file change) had no repair path without human action. Pinned by the reconciliation test in `tests/unit/tools/stage-a-self-report.test.ts` (git fixture + delegation ledger record + wedge-shaped workflow evidence → one green gate run lands `accepted_mutation` + `stage_a_passed` + the `STAGE A RECONCILED` advisory); all stage-b suites stay green.
