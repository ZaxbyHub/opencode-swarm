---
name: swarm-ci-monitor
audience: swarm-plugin
description: Codex adapter for end-to-end CI monitoring of an already-reviewed PR in opencode-swarm. Use when the user wants the swarm to monitor a reviewed-and-approved PR's CI, research every failure exhaustively, fix end-to-end, iterate until green (max 5 cycles), then merge. Composes ci-fix-monitor for fix recipes.
---

# Swarm CI Monitor

Read and follow `../../../.opencode/skills/swarm-ci-monitor/SKILL.md` as the
canonical workflow.

## Codex Execution Notes

- MCP tool names (`mcp__github__*`) are injected by the runtime harness and
  may differ across environments; verify availability via `ToolSearch` before
  first use in a session.
- No `gh` CLI in the remote/MCP environment. Use MCP tools instead:
  - PR checks → `mcp__github__pull_request_read` method `get_check_runs`
  - Failure logs → `mcp__github__get_job_logs` with `job_id`, `return_content: true`
  - PR mergeable/mergeStateStatus/reviewDecision → `mcp__github__pull_request_read` method `get`
- **Merge is new surface area.** There is no `mcp__github__merge_pull_request`
  reference anywhere else in the repo. Verify availability via `ToolSearch`
  before first use in a session. If the tool is unavailable, do not attempt a
  fallback that contradicts the "no `gh` CLI" premise above — surface to the
  user that the merge must be done manually. "`ToolSearch` didn't confirm the
  tool but I'll try it anyway" is not acceptable for the one action in this
  skill that cannot be safely undone — surface to the user instead.
- Do not soften Step 1's pre-flight gates or Step 3's pre-merge re-check —
  this is the first skill in the repo authorized to execute a merge.
- Load `../commit-pr/SKILL.md` before committing or pushing any fix, and
  `../../../.opencode/skills/ci-fix-monitor/SKILL.md` for
  failure-type-specific fix recipes, as the canonical's Composition section
  directs.
- Do not declare victory until the post-merge local-git confirmation (Step 4b)
  passes. Green checks alone are not sufficient.
