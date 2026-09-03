---
name: swarm-pr-review
audience: swarm-plugin
description: >
  Thin adapter for the canonical swarm-pr-review skill. The authoritative
  workflow lives in .opencode and this file only preserves the mirror contract
  for Claude-side skill discovery.
---
# Swarm PR Review
Read and follow `../../../.opencode/skills/swarm-pr-review/SKILL.md` as the canonical workflow.

## Claude Code Execution Notes
- This adapter is a thin shim only.
- Keep the canonical workflow in `.opencode`; do not duplicate protocol text here.
- Only if this session actually exposes the swarm controller tools, use `dispatch_lanes_async`, `collect_lane_results`, and `retrieve_lane_output`; direct-Task dispatch are not equivalent to that controller path.
- If the controller is absent, treat that as Profile B, not an error: use the native `Agent`/`Task` subagent tool flow, keep the PR publication contract intact, and never report BLOCKED merely because the controller is unavailable.
- For exact-head provenance, verify the commit with `git rev-parse --verify <full_pr_head_sha>^0` and `git cat-file -t <full_pr_head_sha>`.
- Preserve the canonical workflow reference above so drift checks can verify delegation.
