# Worktree isolation baseline guidance

## What changed

- Architect guidance now explicitly states that standard parallel-coder worktree isolation is baseline behavior governed by the parallel execution profile and top-level `worktree.policy`, not by Lean Turbo or Epic.
- The `plan`, `specify`, and `brainstorm` skills now include the same anti-misconception callout in both `.opencode` and `.claude` mirrors so early execution-mode decisions do not recommend Lean Turbo merely to obtain worktree isolation.
- `/swarm config doctor` now emits a non-fixable warning when standard parallelization already has baseline worktree isolation active.

## Why

Architects were repeatedly conflating baseline worktree isolation with Lean Turbo because every surface only stated the positive fact that parallel coders use isolated worktrees. The new wording puts the positive statement next to the explicit negation and points Lean Turbo/Epic recommendations at their actual additive behavior.

## Migration steps

None. Existing configuration remains valid. The new config-doctor finding is advisory only and is not auto-fixable.
