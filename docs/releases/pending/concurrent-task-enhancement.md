# Concurrent Task Enhancement

## Summary
Increased the default number of concurrent tasks from 1 to 10, and added adaptive backoff logic to automatically reduce concurrency when task failures are detected.

## What changed
- **Default max_concurrent_tasks**: Increased from 1 to 10 in `ExecutionProfileSchema`
- **Concurrency presets**: Updated to min=1, medium=8, max=16 (previously min=1, medium=3, max=8)
- **Adaptive backoff**: When >20% of tasks in the plan are blocked (failed), concurrency automatically reduces by 50% to prevent cascading failures
- **Consistency fixes**: Updated all fallback defaults in delegation-gate and concurrency commands from 1 to 10

## Why
- **Higher default throughput**: Enables better utilization of parallel task execution when parallelization is enabled
- **Adaptive resilience**: Automatically detects and responds to task failures, scaling back concurrent work when the system is experiencing high failure rates
- **Better UX**: Users can use the new "medium" preset (8) for a strong balance, and "max" (16) for maximum parallelization

## How to use
No migration required. The changes are automatic:

1. **Plans without execution_profile**: New plans will default to `max_concurrent_tasks: 10` when parallelization is enabled
2. **Existing plans**: Not affected; only new plans created after this release will use the new default
3. **Session overrides**: Users can still override concurrency via `/swarm concurrency set <value>`
4. **Adaptive backoff**: When the system detects >20% task failure rate, it automatically reduces concurrency and logs the adjustment

Example concurrency commands:
```
/swarm concurrency set 10          # Set to specific value
/swarm concurrency set medium      # Use preset (8)
/swarm concurrency set max         # Use preset (16)
/swarm concurrency status          # View current state
```

## Migration
No migration required.

## Breaking changes
None. Existing behavior is preserved; only the default has increased.

## Known caveats
- Adaptive backoff only triggers when failure rate exceeds 20%, to avoid over-reacting to minor issues
- The 50% reduction multiplier is fixed; users can manually adjust via `/swarm concurrency set` if needed
- Backoff is reported in parallel execution guidance when triggered
