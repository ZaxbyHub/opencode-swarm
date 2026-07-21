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

- Check out the PR branch locally before dispatching feedback lanes or verifying/fixing anything. Fetch the head ref if absent, confirm the tree is clean, prove full HEAD equals the authoritative PR head SHA, and prove the branch tracks the intended PR head remote/branch. `gh pr checkout` may use only the PR number/URL plus optional `--repo` or `--branch`; never `--force`, `--recurse-submodules`, or detached checkout.
- Build the complete feedback ledger before editing: pasted feedback, GitHub comments/threads, requested changes, CI/check failures, merge conflicts, stale branch state, PR body claims, linked issues, commits, and any validated `swarm-pr-review` handoff artifact.
- Treat every feedback item as a claim until source evidence, tests, logs, or PR metadata prove or disprove it.
- Preserve original finding IDs and reviewer/critic provenance from review handoff artifacts.
- For async verification lanes, treat `output` as a preview and retrieve the full `output_ref` artifact via the runtime's lane-output retrieval capability before classifying or resolving feedback; degraded or incomplete lane outputs keep the affected items open as evidence gaps.
- Do not resolve GitHub review threads unless the user explicitly instructs it.
- **Mandatory gates — Stage A and Stage B (+ closeout).** Stage A always runs exact `git diff --check` plus a targeted reproduction/regression, and also runs every build, typecheck, and lint/format category mechanically discovered from the repository; it never invents a no-op category to reach a fixed count. Stage B (independent `reviewer` + `test_engineer` on the Stage-A-green diff) is mandatory for any change made as part of this process, followed by the separate reviewer + critic closeout gate on the Stage-B-approved diff. Record both closeout verdicts in the runtime's session task-gates artifact using the repository/runtime-specific durable-session guidance; `.swarm/` is plugin runtime state — do not write task artifacts there.
- When the plugin's mechanical tools are available, use `run_pr_feedback_stage_a`, then the exact ordered `swarm-pr-feedback:stage-b-reviewer`, `:stage-b-test`, `:closeout-reviewer`, and `:closeout-critic` structured modes from the canonical skill. Direct subagent calls and free-form verdict prose are not equivalent evidence, and any edit restarts the sequence at Stage A.
- Descendant coder and nested child sessions inherit the parent mechanical gate;
  delegation never grants early commit, push, remote-write, checkout, or
  protected-evidence authority.
- Stage A must execute one proof command on every run: use the exact failing CI/test reproduction when available; otherwise run a repo-appropriate targeted regression/test command for the changed behavior. With `run_pr_feedback_stage_a`, declare the exact test/package/path selector in `targets` and every concrete discovered workspace/category/source obligation with its `working_directory` and `obligation_id`. Standard contained Gradle/Maven wrappers and exact bounded `.pr-validation.json` contract validators are supported only when byte-identical to the immutable `base_ref`/`base_sha` merge-base copy; arbitrary, no-op, mutating, publishing, PR-authored, unverified opaque, fix/update, or selector-free commands fail closed, and every command is checked against unchanged content, HEAD, index, refs, upstream, and Git config.
- After local gates pass, create the reviewed commit with one standalone `git commit`, then call `complete_pr_workflow` once. It fails closed unless the index/worktree are clean and HEAD is a non-merge direct child whose sole parent is the immutable intake head; otherwise it binds that commit to the intended upstream remote-tracking ref and arms publication. Push only with the canonical single-ref form `git push <bound-remote> <bound-commit>:refs/heads/<bound-branch>`; force flags, aliases, wrappers, fetch-based local-ref forgery, extra refspecs, and other remote writes fail closed. Call `complete_pr_workflow` a second time immediately after read-only verification of both the actual remote ref and its local tracking ref proves they point to that exact commit; only then perform explicitly authorized PR comment/body/thread writes.
- Emit the user-facing final response only after the second completion call
  clears the durable gate. Until then, architect response text is mechanically
  replaced and an idle parent session is normally resumed. A user interruption
  pauses automatic wakes until a later explicit user turn.
- Load the repository's test-authoring guidance before changing tests and the repository's PR publication workflow before pushing or updating the PR.

Final responses must include a closure ledger for every original feedback item,
including conflicts, stale branch state, obsolete CI, and generated-output drift
when they affected the PR.
