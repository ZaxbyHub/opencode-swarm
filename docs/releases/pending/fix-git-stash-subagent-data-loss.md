## Fix: `swarm-implement` and `codebase-review-swarm` no longer instruct subagents to `git stash`

**Issue:** #1970 — Both skills told subagents to `git stash` dirty worktrees
before checkout. Under parallel subagent execution, this is worktree-global and
silently destroys sibling agents' in-flight work.

**Fix:** The stash instruction is now orchestrator-owned with safe alternatives
(save branch, git worktree, controller tool). An explicit subagent prohibition
against destructive git operations (`stash`, `reset`, `checkout -- .`,
`restore`) is added to the delegation contract so it reaches agents that never
read the pre-flight section.

**Consistency:** Follows the same pattern as `swarm-pr-review`,
`swarm-pr-feedback`, and `running-tests`, which already prohibit blind stash.
