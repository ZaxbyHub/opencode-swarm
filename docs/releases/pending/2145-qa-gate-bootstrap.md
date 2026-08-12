# Remove the QA gate selection catch-22

MODE: PLAN can now persist a QA gate profile against an exact `swarm_id` and
plan title before the first plan save. The architect freezes that identity,
asks one combined QA/parallelism/commit/auto-proceed question, calls
`set_qa_gates`, and immediately saves the plan with the complete durable
execution profile.

Upgraded legacy plans now recover exact identity binding explicitly through
`set_qa_gates({ swarm_id, plan_title, adopt_legacy_binding_only: true })`.
That action exact-binds the existing QA profile without changing gates or the
lock, so read/save/enforcement paths stay fail-closed until adoption happens.

SPECIFY, BRAINSTORM, and issue ingestion no longer stage execution choices in
`.swarm/context.md`. Per-task checkpoint policy is carried by the plan's
execution profile. Checkpoint creation happens only after task completion via
the exact `save_task_completion` checkpoint action and only after pre-commit
gates pass. Duplicate labels are idempotent success, and other checkpoint
failures stay advisory without undoing completed work.
