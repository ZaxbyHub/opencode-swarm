---
name: swarm-pr-feedback
audience: swarm-plugin
description: >
  Codex adapter for closing known PR feedback in any repository. Use when asked
  to address pasted review feedback, GitHub review comments or threads,
  requested changes, CI/check failures, merge conflicts, stale PR branches, or
  follow-up work that must verify and close all known PR issues.
---

# Swarm PR Feedback

Read and follow `../../../.opencode/skills/swarm-pr-feedback/SKILL.md` as the canonical workflow.

## Codex Execution Notes

- Codex and ZCode sessions normally have no mechanical controller tools: that is canonical Profile B, not an error — both runtimes can spawn fresh-context subagents. Never report BLOCKED merely because those tools are absent — run verification lanes and every gate role as fresh independent subagents with the same one-row-per-item verdict contracts, and keep the ledger, ownership partition, and digest accounting yourself in working notes (never under `.swarm/`, which is plugin runtime state). Use Profile C strictly separated sequential passes, with the procedural independence disclosed in the closure ledger, only when the session genuinely lacks a subagent mechanism.
- Check out the PR branch locally before dispatching feedback lanes or verifying/fixing anything. Fetch the head ref if absent, confirm the tree is clean, prove full HEAD equals the authoritative PR head SHA, and prove the branch tracks the intended PR head remote/branch. `gh pr checkout` may use only the PR number/URL plus optional `--repo` or `--branch`; never `--force`, `--recurse-submodules`, or detached checkout.
- Build the complete feedback ledger before editing: pasted feedback, GitHub comments/threads, requested changes, CI/check failures, merge conflicts, stale branch state, PR body claims, linked issues, commits, and any validated `swarm-pr-review` handoff artifact. Treat every item as a claim until source evidence proves or disproves it, and preserve original finding IDs and reviewer/critic provenance from handoff artifacts.
- Verification (Profiles B/C): every FB item is owned by exactly one verification lane or pass, each returning one `[FEEDBACK-VERIFIED]` row per owned item with the exact PR head SHA recorded. Under Profile A, when a lane result carries an `output_ref`, treat inline lane `output` as a preview and retrieve the full artifact via the runtime's lane-output retrieval capability before classifying; on any profile, degraded or incomplete lane outputs keep the affected items open as evidence gaps. No edits before verification settles.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- **Mandatory gates — Stage A and Stage B (+ closeout) on every profile.** Stage A always runs exact `git diff --check` plus one proof command — the exact failing CI/test reproduction when available, otherwise a repo-appropriate targeted regression/test command — plus every build, typecheck, and lint/format category mechanically discovered from the repository; it never invents a no-op category to reach a fixed count. On Profiles B/C run these commands yourself and record command+output receipts in the ledger; any content change invalidates the receipts and restarts Stage A. Stage B: an independent reviewer role, then a test-engineer role, on the Stage-A-green diff (fresh subagents on B; strictly separated re-derivation passes on C). Closeout: a separate reviewer + critic pair on the Stage-B-approved diff. One verdict row per FB ID at every gate; record both closeout verdicts in the session task-gates artifact per the durable-session guidance.
- Only if the session actually exposes the plugin's mechanical tools, run Profile A instead: `run_pr_feedback_stage_a`, then the exact ordered `swarm-pr-feedback:stage-b-reviewer`, `:stage-b-test`, `:closeout-reviewer`, and `:closeout-critic` structured modes, `complete_pr_workflow` arming, and the bound single-ref push. While that controller is active, direct subagent calls and free-form verdict prose are not equivalent evidence, and any edit restarts the sequence at Stage A.
- Publication (Profiles B/C): after all gates pass on the unchanged diff, create one reviewed commit on the PR branch, push exactly that commit with a single non-force push through the repository's commit/PR workflow, then verify read-only that the remote head equals the pushed commit before any PR comment/body/thread write.
- Load the repository's test-authoring guidance before changing tests and the repository's PR publication workflow before pushing or updating the PR.

Final responses must include a closure ledger for every original feedback item,
including conflicts, stale branch state, obsolete CI, and generated-output drift
when they affected the PR.
