# Per-task commit frequency option in QA gate dialogue

## What changed

- Architect QA gate selection dialogue now asks a follow-up commit-frequency question after gate and parallelization selection.
- The selected commit policy now persists in the durable plan `execution_profile.commit_after_each_completed_task` field instead of a `.swarm/context.md` marker.
- Task completion sequence (MODE: EXECUTE) now includes an optional step that reads the persisted plan execution profile and calls `checkpoint({ action: "save_task_completion", task_id: "<task-id>" })` after each completed task when the policy is enabled.
- Execution-time guidance now comes from the current durable plan, so retries and resumes no longer depend on context-marker drift.
- Checkpoint retention enforcement is now active - oldest checkpoints are evicted when the `checkpoint.max_retention` config limit is exceeded.

## Why

Commit granularity was effectively phase-level with no explicit path for users who want checkpoint commits after each completed task. This adds an opt-in choice during the initial QA gate dialogue and keeps the policy durable across retries, resumes, and plan reloads.

## Migration steps

None. Existing plans without the field continue to default to phase-level behavior.

## Breaking changes

None.

## Known caveats

- Per-task checkpoint commits do not bypass pre-commit QA gates - the full Stage A + Stage B pipeline still runs before the checkpoint is created.
- Per-task checkpoint commits are subject to the existing `checkpoint.max_retention` policy - oldest checkpoints are evicted when the limit is exceeded.
