# SWARM_PLAN export artifacts relocated to `.swarm/plan-export/` (issue #852)

## What

`SWARM_PLAN.{json,md}` checkpoint/export artifacts are now written to `.swarm/plan-export/` instead of flat `.swarm/`. This separates static export artifacts from live plan state.

- **`writeCheckpoint()`** now writes to `.swarm/plan-export/SWARM_PLAN.{json,md}` with a self-documenting header in the `.md` file.
- **`importCheckpoint()`** uses a 3-tier read fallback (`.swarm/plan-export/` → legacy flat `.swarm/` → legacy project root), each legacy tier emits a deprecation warning.
- **`/swarm close`** and **`/swarm reset --confirm`** cleanup now removes SWARM_PLAN artifacts from all three locations (`.swarm/plan-export/`, flat `.swarm/`, and project root).

## Why

Flat `.swarm/` mixed live plan state (`.swarm/plan.json`, `.swarm/plan.md`) with static export checkpoints. Separating them makes the artifact layout more intuitive and makes cleanup unambiguous.

## Migration

No user action required. The change is fully backward-compatible:

- **Reads:** `importCheckpoint()` automatically falls back to legacy flat `.swarm/SWARM_PLAN.json` or root-level `SWARM_PLAN.json` if the new location is empty, emitting a deprecation warning in each case.
- **Writes:** New sessions write to `.swarm/plan-export/` only. Old sessions that still have artifacts in flat `.swarm/` or project root will continue to work; running `/swarm close` cleans up those legacy copies.
- **Cleanup:** `/swarm close` and `/swarm reset --confirm` now target all three locations, so switching to the new layout does not leave orphaned files behind.
