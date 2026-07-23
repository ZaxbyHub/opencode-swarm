---
title: Fix auto_checkpoint_threshold misuse as retention cap
issue: 1691
---

## What changed

`checkpoint.ts` used `auto_checkpoint_threshold` (intended: number of completed tasks before auto-save) as the checkpoint retention limit. This meant setting `auto_checkpoint_threshold: 3` (to auto-checkpoint every 3 tasks) would also cap retention to only 3 checkpoints.

## Fix

- Added `max_retention: z.number().int().min(1).max(100).default(20)` to checkpoint schema
- Changed `checkpoint.ts` to use `max_retention` for the retention limit
- `auto_checkpoint_threshold` now only controls the completed-task auto-save trigger (consumed by update_task_status)

## Acceptance

Setting `auto_checkpoint_threshold: 3` no longer limits retention to 3 checkpoints. Retention defaults to 20 and is independently configurable via `max_retention`.
