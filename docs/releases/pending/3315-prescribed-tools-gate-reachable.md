---
issue: 3315
---

# Every prescribed PR-workflow tool and command is reachable under the gates

The PR-workflow gate now admits every controller tool, observation tool and
shell command the architect prompt and the PR skills prescribe, in the mode
where it is prescribed, with every security floor pinned by regression tests.

- `rebind_pr_feedback_head` is a reachable PR_FEEDBACK controller that
  fast-forwards the branch to the fetched bound tracking head (ff-only, under
  the checkout mutation lock) before rebinding, so a remote-advanced head no
  longer dead-ends the repair. Every shell head-mover stays blocked.
- `pr_workflow_status`, `git_blame` and `gitingest` are no longer misclassified
  as publication tools while PR_FEEDBACK is unarmed; publication-shaped names
  without observe metadata stay blocked.
- Multiple exact paths can be staged with one sanctioned `git add --
  <exact paths>` command (no flags, no globs), each limited to the
  changed-path set the revision digest hashes, under the same ladder
  precondition as the approved commit.
  The swarm-pr-feedback skill now teaches exactly that form.
- Commit messages containing shell metacharacters (e.g. a
  `Co-Authored-By: X <noreply@anthropic.com>` trailer) are committed through
  the new `prepare_pr_feedback_commit_message` controller tool plus
  `git commit -F <outside-repo path>`; in-repo `-F` paths are refused.
  **The commit-message authoring surface ships the issue's default Option B
  and is pending maintainer ratification per AC13 before merge** (Option A
  remains amendable).
- `swarm_command` works for exactly `diagnose` and `guardrail reset` in PR
  modes; `handoff` and `full-auto` stay rejected.
- Ordered PR_FEEDBACK gate dispatches accept an omitted `max_concurrent` as 1
  (PR_REVIEW parity).
- `test_runner` is refused at admission in bound PR_REVIEW with a targeted
  message (its in-place outputs dirtied the exact-PR-head tree); validation
  runs through dispatch lanes or PR_FEEDBACK Stage A. The dirty-tree refusal
  now names the first five offending paths plus a total count.
- A prescribed-tools reachability sweep (architect prompt + both PR skills vs
  the gate) ships as the standing guardrail, with a documented, per-entry-reasoned exclusion list
  (20 tools at landing: prohibitive or post-gate skill mentions, non-PR ceremony/plan
  tools named only outside PR-workflow prose).
- The architect prompt budget ceiling rises 163,000 → 164,000 chars for the
  new staging/rebind/trailer guidance (precedent: #2946).
