---
title: Remove bash/shell from read-only lane tool policy
issue: 1691
---

## What changed

Read-only advisory lanes (reviewer, explorer, critic, sme, researcher) previously included `bash` and `shell` in the read-only tool permission map via `dispatch-lanes.ts`. These tools are OpenCode built-in commands that are not assigned to read-only agent types by default; this change tightens defense-in-depth by removing them from the tool map entirely.

## Fix

Removed `shell` and `bash` from the `READ_ONLY_TOOL_DENYLIST` in `src/tools/dispatch-lanes.ts`. These tools no longer appear in the read-only lane tool permission map at all — they are completely invisible to read-only agents, rather than merely set to `false`. Read-only agents retain all read/search/evidence tools and can no longer run raw shell commands.

## Acceptance

A read-only dispatch lane cannot execute a mutating bash command against the checked-out working tree.
