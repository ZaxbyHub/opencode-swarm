# Graph-first workflow and task attribution completion (#2488)

## What changed

- Finished graph-first workflow wiring across planning, implementation, review, testing, critic, and publication protocols, including source/confidence/freshness fallbacks and test-engineer graph access.
- Unified bounded task-ID resolution across delegation, micro-reflection, delegate acknowledgements, and skill attribution so parallel task calls cannot be attached to mutable session-current state.

## Safety and compatibility

Graph evidence remains advisory and falls back to direct source inspection when evidence is stale, inconclusive, low-confidence, source-free, unavailable, or unsupported. Existing plan-task IDs and legacy named attribution IDs remain supported; ambiguous, unsafe, and over-limit inputs fail closed without blocking the surrounding best-effort hooks.
