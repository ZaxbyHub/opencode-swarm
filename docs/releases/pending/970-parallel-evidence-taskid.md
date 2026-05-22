# Parallel Task Evidence Recording Fix

## Overview

Fixes evidence recording when multiple reviewer/test_engineer agents are dispatched for different tasks from the same architect session. Previously, all evidence was recorded against whichever task had the last `update_task_status(in_progress)` call, leaving other tasks with zero evidence and blocking their completion.

## What changed

- Added `resolveEvidenceTaskId` helper to `src/hooks/delegation-gate.ts` that chains three resolution steps: (1) explicit `task_id` in tool args, (2) prompt-text extraction via `resolveDelegatedPlanTaskId` with plan-aware filtering, (3) session-state fallback via `getEvidenceTaskId`.
- Replaced inline `rawTaskId`/`getEvidenceTaskId` logic in both the stored-args evidence path and the delegation-chain fallback path with the new shared helper.
- When the plan file is unavailable, text extraction is skipped entirely to prevent version-like patterns (e.g., "v6.33.7") from being misidentified as task IDs.
- Stored-args and direct-args are now merged (not just `??`) so prompt/description fields from either source are available to the resolver.

## How to use

No changes needed. Evidence recording now correctly resolves task IDs from delegation context when parallel Stage B dispatches occur.

## Migration

No migration required.

Closes: #970
Related: #956, PR #961
