---
name: swarm-pr-review
audience: swarm-plugin
description: >
  Thin adapter for the canonical swarm-pr-review skill. The authoritative
  workflow lives in .opencode and this file only preserves the mirror contract
  for Codex-side skill discovery.
---
# Swarm PR Review
Read and follow `../../../.opencode/skills/swarm-pr-review/SKILL.md` as the canonical workflow.

## Codex Execution Notes
- This adapter is a thin shim only.
- Keep the canonical workflow in `.opencode`; do not duplicate protocol text here.
- Treat the runtime's parallel-execution capability as the path for one structured exact-six batch; a different dispatch path is not equivalent.
- Treat controller absence as Profile B, not an error: use fresh-context subagents, preserve read-only workflow-lane handling and exact-head provenance, keep `output_ref` recovery intact, preserve the PR publication contract, and never report BLOCKED merely because the controller is absent or the only alternative would be a degraded review.
- For exact-head provenance, verify the commit with `git rev-parse --verify <full_pr_head_sha>^0` and `git cat-file -t <full_pr_head_sha>`.
- Preserve the canonical workflow reference above so drift checks can verify delegation.
