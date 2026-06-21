---
name: codebase-review-swarm
description: >
  Codex adapter for running a rigorous, quote-grounded codebase review or
  security/QA/accessibility/performance/AI-slop/enhancement audit. Use for
  full-repo or large-subsystem review reports; not for normal implementation.
---

# Codebase Review Swarm

Read and follow `../../../.opencode/skills/codebase-review-swarm/SKILL.md` as
the canonical workflow.

## Codex Execution Notes

- Treat this as a read-only review workflow. Do not modify source files.
- Write review artifacts only under `.swarm/review-v8/runs/<run_id>/`.
- Run Phase 0 inventory first and stop for review-mode selection unless the
  user already selected tracks and explicitly authorized continuing.
- Preserve the skill's evidence rule: no quote, no claim.
- For dispatch lanes, treat `output` as a preview and call
  `retrieve_lane_output` for full `output_ref` artifacts before consuming
  ledgers, counting candidates, routing validation, or declaring coverage clean;
  degraded or incomplete lane output is an explicit coverage limitation.
- Use `rg`, focused file reads, targeted shell commands, and independent
  validation to close coverage units before writing the final report.
- If the user asks for fixes after the report, start a separate implementation
  workflow rather than editing during the review run.
