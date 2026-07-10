---
name: gate-attribution
description: Per-task gate dispatch protocol. Documents single-task attribution plus parseable set-dispatch reviewer/test_engineer rows.
---

# Gate Attribution

## The rule
The gate tracker attributes reviewer/test_engineer dispatches PER TASK. A
single-task prompt still attributes by `task_id` / `taskId` / unambiguous prompt
task ID. A set-dispatch can also count per-task when the reviewer/test_engineer
output includes parseable per-task rows:

```
[REVIEWED] | task-2.1 | APPROVED | ...
[REVIEWED] | 2.2 | PASS | ...
```

Rows with `task-X.Y` are normalized to `X.Y`; unsafe or non-plan IDs are ignored.
Only passing verdicts (`APPROVED`, `PASS`, or `PASSED`) create gate evidence.
Rows such as `NEEDS_REVISION` are reviewed rows but do not satisfy the gate. If
no reviewed rows are parseable, attribution falls back to the single-task rule.

## Protocol
1. **For unrelated or high-risk tasks:** Dispatch separate reviewer and/or test_engineer lanes with exactly ONE taskId.
2. **For a true set-dispatch:** Require one `[REVIEWED] | task-id | verdict | ...` row per task in the returned output. Only passing verdict rows count.
3. **Minimize overhead via parallel dispatch when set-dispatch is not appropriate:**
   ```
   dispatch_lanes_async with:
   - common_prompt: shared verification context
   - lanes: one lane per task, each with a single taskId
   - max_concurrent: up to 3
   ```
4. **Collect + attribute:** Single-task lanes auto-attribute to their taskId; set-dispatch rows auto-attribute per parsed row.
5. **Do NOT rely on prose summaries:** A batched dispatch without parseable rows is ambiguous and does not count per-task.

## Optimization for trivial tasks
For pure ceremony gates (1-line doc fix):
```
TASK: Verify task X.Y. Run skill-mirrors.test.ts. PASS/FAIL.
taskId: X.Y
```

## Why this exists
The gate tracker (`src/hooks/delegation-gate.ts`) keys delegation chains by
`sessionID`. Ambiguous multi-task prompts still fail closed, but parseable
`[REVIEWED] | task-id | ...` rows provide explicit per-task attribution for
set-dispatches. Tracked in issue #1746 item 6.
