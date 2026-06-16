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
The changes are automatic for most users:

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

### Preset value changes
If you use preset values in scripts or automation, be aware that the numeric values have changed:

| Preset | Old value | New value |
|--------|-----------|-----------|
| `medium` | 3 | 8 |
| `max` | 8 | 16 |

For example, `/swarm concurrency set medium` now sets concurrency to 8 (previously 3), and `/swarm concurrency set max` now sets it to 16 (previously 8).

**Action needed**: If your scripts rely on specific preset numeric values, update them to match the new defaults.

### Default change
The new default for plans without an explicit `execution_profile` is 10 (previously 1). This only affects **new plans** created after this release—existing plans are unaffected.

## Breaking changes
None for new plans. Existing behavior is preserved for plans without `execution_profile`; only the default has increased.

## Breaking changes for preset users
None—preset names remain the same, only their numeric values changed.

## Known caveats
- Adaptive backoff only counts tasks explicitly blocked by execution failures (status `blocked` with a `blocked_reason` containing "fail", "error", or "exception"). Tasks waiting on dependencies do not count toward the threshold.
- Requires at least 2 blocked tasks to trigger. This prevents single-task flakiness in small plans from causing unnecessary throttling.
- Adaptive backoff only triggers when failure rate exceeds 20%, to avoid over-reacting to minor issues
- The 50% reduction multiplier is fixed; users can manually adjust via `/swarm concurrency set` if needed
- Backoff is reported in parallel execution guidance when triggered
