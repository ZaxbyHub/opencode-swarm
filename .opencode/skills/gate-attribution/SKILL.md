---
name: gate-attribution
description: Per-task gate dispatch protocol. Documents the single-taskId attribution rule and parallel-lane optimization for reviewer/test_engineer gates.
---

# Gate Attribution

## The rule
The gate tracker attributes reviewer/test_engineer dispatches PER TASK (single taskId in the prompt). Set-dispatches covering multiple tasks do NOT count per-task, even with per-task verdicts.

## Protocol
1. **For each task requiring a gate:** Dispatch a separate reviewer and/or test_engineer with exactly ONE taskId
2. **Minimize overhead via parallel dispatch:**
   ```
   dispatch_lanes_async with:
   - common_prompt: shared verification context
   - lanes: one lane per task, each with a single taskId
   - max_concurrent: up to 3
   ```
3. **Collect + attribute:** Each lane result auto-attributes to its taskId
4. **Do NOT batch:** Even for identical reviews, dispatch separately

## Optimization for trivial tasks
For pure ceremony gates (1-line doc fix):
```
TASK: Verify task X.Y. Run skill-mirrors.test.ts. PASS/FAIL.
taskId: X.Y
```

## Why this exists
The gate tracker (`src/hooks/delegation-gate.ts`) keys delegation chains by `sessionID`, and task attribution resolves exactly ONE taskId per dispatch (`args.task_id ?? args.taskId`). Ambiguous multi-task prompts fail closed (resolve to null) rather than attributing to any task — so a set-dispatch covering multiple tasks does not count per-task even with per-task verdicts. Tracked in issue #1746 item 6.
