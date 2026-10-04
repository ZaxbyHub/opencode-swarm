# Fix: Turbo's Stage A bypass decides Tier 3 by the task's files

## What

In Turbo mode, the delegation gate lets a coder be re-dispatched before Stage A
for any task that is not Tier 3. It decided Tier 3 from the task id
(`taskId.startsWith('3.')`), so:
- every task in phase 3 lost the bypass;
- a task in any other phase that touches auth, crypto, secret or other
  security-sensitive files kept it.

The gate now uses the file-based Tier 3 classifier
(`src/parallel/tier3-classifier.ts`) on the task's planned `files_touched`.
`update_task_status` already uses the same rule for Turbo's Stage B bypass.
Only a task whose files are known and contain no Tier 3 path is bypassable. An
unknown task, an empty file list or an unreadable plan is not.
