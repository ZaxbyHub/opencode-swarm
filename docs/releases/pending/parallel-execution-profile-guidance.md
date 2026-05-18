# Parallel execution-profile guidance for architects

## What changed

- Architect deliberation guidance now honors standard execution profiles. When `.swarm/plan.json` has `execution_profile.parallelization_enabled=true` and `max_concurrent_tasks > 1`, the model-only `[NEXT]` guidance lists dependency-ready pending tasks up to the available slot count.
- Active coder and gate work counts against the slot budget, so architects are nudged to fill open slots without over-dispatching.
- The guidance reads `plan.json` through the schema-backed safe loader and fails open to serial guidance when the plan is missing or invalid.
- Active Lean Turbo sessions suppress standard execution-profile slot filling and continue to point at the Lean Turbo phase runner.
- Stage B reviewer/test_engineer instructions now explicitly allow dispatching both gate agents for the same completed coder task before waiting, while preserving one task per coder call.

## Why

Fixes Issue #892. Standard execution profiles could record `max_concurrent_tasks`, but the architect's normal deliberation path did not surface dependency-ready work or available slots, so agents often drifted back into serial reviewer/test_engineer and coder dispatch behavior.

## Migration steps

None. Existing plans with `parallelization_enabled=false` or `max_concurrent_tasks=1` keep the prior serial guidance.

## Breaking changes

None.

## Known caveats

This change adds deterministic model guidance for standard execution-profile slot filling. Lean Turbo remains the deterministic lane runner for full phase-level parallel execution.
