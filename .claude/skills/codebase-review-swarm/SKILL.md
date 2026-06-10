---
name: codebase-review-swarm
description: >
  Claude Code adapter for running a rigorous, quote-grounded codebase review
  or security/QA/accessibility/performance/AI-slop/enhancement audit. Use for
  full-repo or large-subsystem review reports; not for normal implementation.
---

# Codebase Review Swarm

Read and follow `../../../.opencode/skills/codebase-review-swarm/SKILL.md` as
the canonical workflow.

## Claude Code Execution Notes

- Treat this as a read-only review workflow. Do not modify source files.
- Write review artifacts only under `.swarm/review-v8/runs/<run_id>/`.
- Run Phase 0 inventory first and stop for review-mode selection unless the
  user already selected tracks and explicitly authorized continuing.
- Preserve the skill's evidence rule: no quote, no claim.
- Use independent reviewer and critic passes before finalizing report findings.
