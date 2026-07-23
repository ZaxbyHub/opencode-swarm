---
title: Remove bash/shell from read-only lane tool policy
issue: 1691
---

## What changed

Read-only advisory lanes (reviewer, explorer, critic, sme, researcher) had `bash` and `shell` in their allowed-tools list via `dispatch-lanes.ts`. A "read-only" reviewer could execute arbitrary mutating shell commands against the working tree.

## Fix

Removed `shell` and `bash` from the `READONLY_LANE_TOOLS` set in `src/tools/dispatch-lanes.ts`. Read-only agents retain access to `lint` (which internally spawns linters safely) and all read/search/evidence tools. They can no longer run raw shell commands.

## Acceptance

A read-only dispatch lane cannot execute a mutating bash command against the checked-out working tree.
