# Per-invocation plan read cache (ENH-3) and session teardown on close (ENH-5)

## What changed

**ENH-3 — per-turn plan read memoization**

`readSwarmFileAsync` in `src/hooks/utils.ts` now accepts an optional
`cache?: Map<string, Promise<string | null>>` parameter. When a cache Map is
passed, the function stores the Promise (before awaiting it) keyed by
`directory::filename`, so concurrent calls for the same file within the same
turn resolve from the in-flight Promise rather than issuing a second `stat()`
call.

`chat.system.transform` in `src/hooks/system-enhancer.ts` creates a fresh
`planReadCache` Map per invocation and threads it through every plan read:
`loadPlan`, `isPlanMdInSync`, `detectArchitectMode`, and direct
`readSwarmFileAsync` calls. The Map is discarded when the handler returns, so
there is no cross-turn cache sharing.

Callers that do not pass a cache see identical behavior — the parameter is
optional and the existing process-level stat-based cache in
`src/utils/swarm-artifact-cache.ts` continues to deduplicate across turns.

**ENH-5 — wire endAgentSession at `/swarm close`**

`endAgentSession` in `src/state.ts` had zero production callers. Sessions
accumulated in `swarmState.agentSessions` until the 2-hour stale eviction
fired or the process restarted.

`src/commands/close.ts` now snapshots all session IDs before calling
`resetSwarmStatePreservingSingletons()` and calls `endAgentSession` for each
one, giving sessions an explicit lifecycle end at close time. The stale
eviction at `src/state.ts:609` is preserved as a safety net.

## Why

Both fixes reduce redundant work per architect turn and improve session state
hygiene:

- ENH-3 eliminates duplicate `stat()` calls when multiple functions read
  the same plan file within a single `chat.system.transform` invocation.
  Measured in tests: `validateSwarmPath` is called once per unique filename
  per invocation with the cache, versus once per call site without it.

- ENH-5 ensures agent sessions receive an explicit `delete` from the Map
  at the well-defined `/swarm close` teardown boundary, rather than relying
  solely on the background 2-hour eviction window.

## Migration steps

No migration required. Both changes are backwards-compatible:

- ENH-3: the `cache?` parameter is optional; existing callers passing only
  `(directory, filename)` behave identically to before.
- ENH-5: `endAgentSession` already existed and is idempotent (double-close
  is a no-op). No API or configuration changes.

## Breaking changes

None.

## Known caveats

- ENH-3 gap: `parsePlanJsonCached` (called inside `loadPlan`) issues its own
  `readSwarmFileAsync` call without the per-invocation cache. The
  process-level stat-based cache in `swarm-artifact-cache.ts` still
  deduplicates the actual I/O for `plan.json`, so there is no regression —
  only an incomplete optimization for that specific call path.
