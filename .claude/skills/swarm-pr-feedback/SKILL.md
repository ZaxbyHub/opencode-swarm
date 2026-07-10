---
name: swarm-pr-feedback
description: >
  Claude Code adapter for closing known PR feedback. Use when addressing pasted
  review feedback, GitHub review comments or threads, requested changes,
  CI/check failures, merge conflicts, stale PR branches, or PR follow-up work
  that must verify every claim before fixing it.
---

# Swarm PR Feedback

Read and follow `../../../.opencode/skills/swarm-pr-feedback/SKILL.md` as the
canonical workflow.

## Claude Code Execution Notes

- **Batch-collect all CI failures before proposing any fix** (Issue #1746).
  Run `gh pr checks --json checkName,conclusion,detailsUrl`, then for each
  failing check run `gh run view <run-id> --log-failed`. Build the complete
  failure ledger before triaging or proposing fixes — do not iterate
  check-by-check through push cycles.
- Check out the PR branch locally before verifying or fixing anything. Fetch the
  head ref if absent, confirm the working tree is clean, then verify against the
  PR branch rather than the base branch.
- Build the complete feedback ledger before editing: pasted feedback, GitHub
  comments/threads, requested changes, CI/check failures (already batch-
  collected above), merge conflicts, stale branch state, PR body claims,
  linked issues, commits, and any validated `swarm-pr-review` handoff artifact.
- Treat every feedback item as a claim until source evidence, tests, logs, or
  PR metadata prove or disprove it.
- Preserve original finding IDs and reviewer/critic provenance from review
  handoff artifacts.
- For async verification lanes, treat `output` as a preview and call
  `retrieve_lane_output` for full `output_ref` artifacts before classifying or
  resolving feedback; degraded or incomplete lane outputs are coverage gaps that
  must be closed by retry, a verified-equivalent alternative, or Task-tool
  dispatch as the final fallback when lane tools do not work. If the gap cannot
  be closed, stop and surface the affected items to the user as BLOCKED rather
  than producing degraded closure.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- **Mandatory gates — Stage A and Stage B (+ closeout).** Stage A (structural
  pre-checks: build, typecheck, lint/format, `git diff --check`, reproduce the
  failing CI/test command) and Stage B (independent `reviewer` + `test_engineer`
  on the Stage-A-green diff) are MANDATORY for any change made as part of this
  process, followed by the separate reviewer + critic closeout gate on the
  Stage-B-approved diff. No fix lands, no closure ledger row is marked FIXED,
  and no PR is published until all three gates pass on the current diff. See
  the canonical "Mandatory Gates" section for the full protocol. Record both
  closeout verdicts in `.claude/session/tasks/<slug>/gates.md` per
  `durable-session-state` (`.swarm/` is plugin runtime state — do not write
  task artifacts there).
- Use the repository commit/PR workflow before pushing or updating the PR.

Final output must include a closure ledger for every original feedback item,
including conflicts, stale branch state, obsolete CI, and generated-output drift
when they affected the PR.
