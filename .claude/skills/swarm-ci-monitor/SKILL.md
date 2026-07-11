---
name: swarm-ci-monitor
audience: swarm-plugin
description: >
  Claude Code adapter for end-to-end CI monitoring of an already-reviewed PR
  in opencode-swarm. Use when the user wants the swarm to monitor a
  reviewed-and-approved PR's CI, research every failure exhaustively, fix
  end-to-end, iterate until green (max 5 cycles), then merge. Composes
  ci-fix-monitor for fix recipes. This is the first skill in the repo that
  executes a merge — invoke it deliberately.
disable-model-invocation: true
---

# Swarm CI Monitor

Read and follow `../../../.opencode/skills/swarm-ci-monitor/SKILL.md` as the
canonical workflow.

## Claude Code Execution Notes

- `gh` CLI is available natively; use it directly for every step (checks,
  merge, git operations) — the canonical's MCP tool-mapping table is for the
  Codex adapter, not this environment.
- This is the first skill in the repo authorized to execute `gh pr merge`. Do
  not soften or skip the pre-flight gates (Step 1), the pre-merge staleness
  re-check (Step 3), or the post-merge local-git confirmation (Step 4b) — they
  are the load-bearing safety mechanism, not optional ceremony.
- Load `../commit-pr/SKILL.md` before any commit/push inside the fix loop, and
  `../../../.opencode/skills/ci-fix-monitor/SKILL.md` for
  failure-type-specific fix recipes, as the canonical's Composition section
  directs.
- Do not declare victory on green checks alone — Step 4b's local-git
  confirmation, via a different system than the GitHub API, is the
  independent gate.
