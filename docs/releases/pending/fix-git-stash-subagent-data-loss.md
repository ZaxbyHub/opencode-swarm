# `swarm-implement` and `codebase-review-swarm` no longer instruct subagents to `git stash`

**Issue:** #1970 — Both skills told subagents to `git stash` dirty worktrees
before checkout. Under parallel subagent execution, this is worktree-global and
silently destroys sibling agents' in-flight work.

**Fix:** The stash instruction is now orchestrator-owned. The recommended safe
alternatives are the controller-owned `prepare_pr_workflow_checkout` (preserves
every dirty path, including untracked files, and returns a recovery command) and
a git worktree. The skills now also warn that `git branch tmp/save-<topic>` only
moves the HEAD ref and does not preserve uncommitted changes, so it must not be
relied on to save dirty work. An explicit subagent prohibition against
destructive git operations (`stash`, `reset`, `checkout -- .`, `restore`) is
added to the delegation contract so it reaches agents that never read the
pre-flight section.

**Consistency:** Follows the same pattern as `swarm-pr-review`,
`swarm-pr-feedback`, and `running-tests`, which already prohibit blind stash.

**Scope note:** This fix is scoped to the parallel-subagent dispatch skills named
in #1970 (`swarm-implement`, `codebase-review-swarm`), where `git stash` is
worktree-global and destroys sibling agents' work. `.claude/skills/commit-pr/SKILL.md`
recommends "temporary save branches over `git stash`" as a session-hygiene hint; it
is a serial orchestrator-only skill (no parallel subagents), pre-existing on `main`,
and intentionally cited by #1970 as the precedent for this fix — so it is out of
scope here. If tightened later, "save branch" should specify the commit step, since a
bare `git branch <name>` moves only the HEAD ref and does not preserve uncommitted
changes.
