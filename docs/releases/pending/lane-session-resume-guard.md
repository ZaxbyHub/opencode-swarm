# Fix: a Task dispatch can no longer resume an isolated coder's session as another agent

## What

With worktree isolation, the plugin rewrites an isolated coder's Task `task_id`
to the lane's child session id. The Task result then returns
`<task id="ses_…">`. If the architect reused that id as `task_id` on its next
dispatch (for example the Stage B test_engineer), OpenCode resumed the
**coder's** session as the new agent: inside the coder's lane, with its
history and scope.

The plugin now records the lane child sessions it creates. The delegation gate
refuses a Task dispatch whose `task_id` names one of them for a different agent
(`TASK_SESSION_RESUME_MISMATCH`). The error tells the architect to set
`task_id` to the plan task id (for example `"1.1"`) or omit it, and never to
pass a `ses_…` id returned in a Task result for a different agent. The
architect prompt's TASK ATTRIBUTION section now says the same.

Unchanged:
- resuming the same agent's session;
- plan task ids;
- session ids the plugin did not create.

Known limit: the plugin keeps the record of lane sessions in memory. After
OpenCode restarts, the guard does not know the lane sessions created before
the restart.

## Why

Found in a live run with worktree isolation on: the test_engineer for a
parallel task ran inside the coder's session and lane.
