# Skill Updates: Test Execution Gate and Delegation Strategy

## What changed
- **`swarm-pr-review` skill**: Added mandatory test execution phase to the pre-synthesis gate. When reviewing a PR, the orchestrator now runs the affected test suite in parallel with explorer lanes and classifies failures as REGRESSION or PRE_EXISTING before producing the final output.
- **`pr-review-fix` skill**: Added Step 1a — delegation strategy documentation covering plan-based vs Task-only approaches when fixing PR review findings on branches without a swarm plan.

## Why
PR #959 uncovered 15 regressions that only test execution revealed — code review alone did not surface them. The test execution gate closes this gap. The delegation strategy section documents the Task-only fallback for PR fix branches where the plan system's scaffolding (spec.md, plan.json, QA gate) is unavailable.

## Migration
No migration required. Skills are self-documenting workflow guidance.
