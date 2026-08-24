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
- Preserve the canonical workflow reference above so drift checks can verify delegation.
