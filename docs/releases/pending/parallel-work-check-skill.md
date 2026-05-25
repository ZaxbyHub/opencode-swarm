# Parallel Work Check Skill

## What changed
- Added new `parallel-work-check` skill that prevents wasted effort when multiple agents work on the same branch concurrently
- Integrated parallel work checking into `pr-review-fix` skill (new Step 0)
- Integrated parallel work checking into `swarm-implement` skill (new Phase 0a)
- All skills now cross-reference each other with correct relative paths

## Why
During work on PR #961, a parallel swarm had already completed superior fixes on the same branch. Our session spent significant effort on incremental patches that were ultimately superseded by the parallel swarm's "restore from main + re-integrate" approach. This skill prevents such waste by mandating a remote branch check before starting work.

## How to use
The skill is automatically triggered when:
- Loading `pr-review-fix` skill to process PR review feedback
- Loading `swarm-implement` skill to execute complex implementation work
- Any workflow that begins work on an existing branch

The protocol checks:
1. Fetch remote branch state
2. Compare local vs remote HEAD
3. Detect parallel swarm work by commit authors
4. Evaluate whether to proceed, integrate, or abandon in favor of remote work

## Migration
No migration required. Existing skill files are updated in place.
