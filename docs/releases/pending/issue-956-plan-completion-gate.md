### Plan completion guardrail

- Added a runtime guard that blocks starting a different task after reviewer/test_engineer gates have completed until the architect calls `update_task_status(..., status: "completed")`, keeping `.swarm/plan.md` from remaining stale while work advances.
- The guard now covers `update_task_status(status: "in_progress")`, `declare_scope`, and coder delegation for another task, while preserving same-task retries and the required completion-status escape hatch.
- Added model-only `[NEXT]` guidance that tells the architect to print the task completion checklist and call `update_task_status` before `declare_scope` or the next task.
