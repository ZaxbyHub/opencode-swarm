# Per-task commit frequency option in QA gate dialogue

## What changed

- Architect QA gate selection dialogue now asks a follow-up commit-frequency question after gate and parallelization selection.
- When users choose per-task commits, a `## Task Completion Commit Policy` section is written to `.swarm/context.md` with `commit_after_each_completed_task: true`.
- Task completion sequence (MODE: EXECUTE) now includes an optional step that reads the policy and calls `checkpoint save` after each completed task when the policy is enabled.
- The commit policy section is preserved in context.md as execution-time guidance (not consumed like pending gate-selection sections).
- Checkpoint retention enforcement is now active — oldest checkpoints are evicted when the `auto_checkpoint_threshold` config limit is exceeded.

## Why

Commit granularity was effectively phase-level with no explicit path for users who want checkpoint commits after each completed task. This adds an opt-in choice during the initial QA gate dialogue.

## Migration steps

None. Existing projects default to phase-level behavior (no commit policy section in context.md).

## Breaking changes

None.

## Known caveats

- Per-task checkpoint commits do not bypass pre-commit QA gates — the full Stage A + Stage B pipeline still runs before the checkpoint is created.
- Per-task checkpoint commits are subject to the existing `auto_checkpoint_threshold` retention policy — oldest checkpoints are evicted when the limit is exceeded.
