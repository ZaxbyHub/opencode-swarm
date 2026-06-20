# First-class parallel coders with worktree isolation

## What changed

Worktree isolation for parallel coders shipped previously but was almost never
used: the machinery only triggers when a plan's `execution_profile` has
`parallelization_enabled` with `max_concurrent_tasks > 1`, and nothing in the
architect's workflow drove that. The architect asked a passive "How many coders
should run in parallel? (default: 1)" with no context, never mentioned
worktrees, and its dispatch rules actively forbade sending more than one coder.
This change makes parallel execution + worktree isolation first-class:

- **Architect proactively recommends parallelism** (`src/agents/architect.ts`,
  `.claude/skills/plan/SKILL.md`, `.opencode/skills/plan/SKILL.md`): the
  parallel-coders question now explains that parallel coders each run in an
  isolated git worktree (separate working dir + branch, auto-merged back) and
  instructs the architect to inspect the plan, group dependency-ready tasks with
  **non-overlapping** file scopes, and recommend a concurrency count — falling
  back to serial when scopes overlap or are unknown.

- **Parallel coder dispatch is now permitted** (`src/agents/architect.ts` Rule 2):
  added an explicit exception so that when an active `[PARALLEL EXECUTION PROFILE]`
  directive is present, the architect may dispatch multiple coders in one message
  (up to `max_concurrent_tasks`) for distinct, file-disjoint, dependency-ready
  tasks. Each coder still gets its own `declare_scope` and exactly one task.

- **Coder worktree awareness** (`src/agents/coder.ts`): coders are told they may
  run inside an isolated worktree, to work normally (changes are merged back
  automatically), not to run git worktree/branch commands themselves, and to stay
  within their declared file scope.

- **Reviewer gate parallel exemption** (`src/hooks/delegation-gate.ts`): the
  reviewer gate previously blocked dispatching any second coder while a prior
  coder task awaited review, with the only bypass being Lean Turbo. It now exempts
  standard `parallelization_enabled` sessions: a coder for a **different**
  dependency-ready task is allowed while others await review, bounded by
  `max_concurrent_tasks` (new `PARALLEL_SLOTS_EXHAUSTED` guard). Re-delegating the
  **same** unreviewed task is still blocked, and serial sessions are unchanged.
  The slot cap applies whenever parallel mode is active, even when the incoming
  coder's task id is not parseable, so an ambiguous dispatch cannot oversubscribe
  in-flight coders.

- **Isolation-failure safety under the `auto` policy**
  (`src/hooks/delegation-gate/worktree-isolation.ts`): when worktree provisioning
  or the lane session fails under the default best-effort (`auto`) policy, the
  triggering coder no longer silently runs un-isolated in the main tree while
  sibling coders are isolated in worktrees. If a sibling dispatch is in-flight,
  the failing dispatch is blocked with `STANDARD_WORKTREE_ISOLATION_UNSAFE` so the
  architect waits for in-flight coders to merge back; with no sibling in-flight it
  still degrades gracefully to un-isolated serial execution.

## Why

The worktree machinery was sound (162 existing tests pass) but unreachable in
normal use. These changes connect the architect's deliberation and dispatch path
to the isolation machinery so parallel coders are recommended and actually
dispatchable when tasks are independent — increasing throughput while keeping
file-scope safety (worktree merge-back aborts and preserves work on conflict).

## Notes

- Global config defaults are unchanged (parallelization still opt-in per plan);
  the architect now recommends it when appropriate rather than defaulting to 1
  silently.
- Tests added: reviewer-gate parallel-exemption contract
  (`tests/unit/hooks/delegation-gate-worktree-isolation.test.ts`), dialogue
  worktree-concept presence (`src/__tests__/qa-gate-hardening.test.ts`), and a
  lockstep guard across the architect dialogue and both plan-skill copies
  (`tests/unit/skills/plan-protocol.test.ts`).
