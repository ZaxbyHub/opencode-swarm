---
name: swarm-pr-feedback
audience: swarm-plugin
description: >
  Claude Code adapter for closing known PR feedback. Use when addressing pasted
  review feedback, GitHub review comments or threads, requested changes,
  CI/check failures, merge conflicts, stale PR branches, or PR follow-up work
  that must verify every claim before fixing it.
---

# Swarm PR Feedback

Read and follow `../../../.opencode/skills/swarm-pr-feedback/SKILL.md` as the canonical workflow.

## Claude Code Execution Notes

- A plain Claude Code session has none of the plugin's mechanical controller tools: that is canonical Profile B, not an error. Never report BLOCKED merely because controller tools are absent — run verification lanes and gate roles as fresh `Agent`/`Task` subagents and keep the ledger, ownership partition, and digest accounting yourself in session task workspace files (never under `.swarm/`, which is plugin runtime state).
- **Batch-collect all CI failures before proposing any fix** (Issue #1746). On GitHub, run `gh pr checks <n> --json name,bucket,state,link`, filter to `bucket == "fail" || bucket == "cancel"`, then fetch each failed log with `gh run view <run-id> --log-failed`. On other hosts, use the host-equivalent API. Build the complete failure ledger in one batch before triaging or proposing fixes — do not iterate check-by-check through push cycles.
- Check out the PR branch locally before dispatching feedback lanes or verifying/fixing anything. Fetch the head ref if absent, preserve or surface all dirty tracked/untracked state, prove full HEAD equals the authoritative PR head SHA, and prove the final branch tracks the intended PR head remote/branch. In Profile A, a detached exact-head intake is valid because the first bind attaches only one unambiguous exact tracking ref; Profiles B/C must establish the branch themselves. Never use force or submodule-recursive checkout.
- Build the complete feedback ledger before editing: pasted feedback, GitHub comments/threads, requested changes, CI/check failures, merge conflicts, stale branch state, PR body claims, linked issues, commits, and any validated `swarm-pr-review` handoff artifact. Treat every item as a claim until source evidence proves or disproves it, and preserve original finding IDs and reviewer/critic provenance from handoff artifacts.
- Verification lanes (Profile B): partition the immutable FB inventory across fresh read-only subagents — every item owned by exactly one lane, one `[FEEDBACK-VERIFIED]` row per owned item, the exact PR head SHA in every prompt — and read each subagent's full report. Under Profile A, when a lane result carries an `output_ref`, treat inline `output` as a preview and call `retrieve_lane_output` for the full artifact. Degraded, truncated, or incomplete reports keep their items open as coverage gaps: retry bounded, or surface the affected items as BLOCKED. No edits before verification settles.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- **Mandatory gates — Stage A and Stage B (+ closeout) on every profile.** Stage A always runs exact `git diff --check` plus one proof command — the exact failing CI/test reproduction when available, otherwise a repo-appropriate targeted regression/test command — plus every build, typecheck, and lint/format category mechanically discovered from the repository; it never invents a no-op category to reach a fixed count. On Profile B run these commands yourself and record command+output receipts in the ledger; any content change invalidates the receipts and restarts Stage A. Stage B: one fresh independent reviewer subagent, then one fresh test-engineer-role subagent, on the Stage-A-green diff. Closeout: a separate fresh reviewer + critic pair on the Stage-B-approved diff. One verdict row per FB ID at every gate; record both closeout verdicts in the session task-gates artifact per the durable-session-state guidance.
- Only if this session actually exposes the plugin's mechanical tools, run Profile A instead: `run_pr_feedback_stage_a`, then the exact ordered `swarm-pr-feedback:stage-b-reviewer`, `:stage-b-test`, `:closeout-reviewer`, and `:closeout-critic` structured modes, `complete_pr_workflow` arming, and the bound single-ref push. While that controller is active, direct subagent calls and free-form verdict prose are not equivalent evidence, and any edit restarts the sequence at Stage A.
- Publication (Profile B): after all gates pass on the unchanged diff, create one reviewed commit on the PR branch, push exactly that commit with a single non-force push through the repository's commit/PR workflow, then verify read-only that the remote head equals the pushed commit before any PR comment/body/thread write.

Final output must include a closure ledger for every original feedback item,
including conflicts, stale branch state, obsolete CI, and generated-output drift
when they affected the PR.
