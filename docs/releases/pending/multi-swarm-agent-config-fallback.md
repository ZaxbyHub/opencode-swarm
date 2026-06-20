# `fix(agents)`: multi-swarm agent config fallback resolution

## Summary

- Fixed critical bug in multi-swarm mode where `_swarmAgents` singleton was overwritten on each swarm iteration, causing all fallback model resolutions to use the last-processed swarm's config
- Replaced single-slot `_swarmAgents` with `_swarmAgentsMap: Map<swarmId, config>` to store each swarm's agent config independently
- Added `extractSwarmIdFromAgentName()` helper to extract swarm prefix from agent names (e.g., "local_coder" → "local")
- Updated `getSwarmAgents(swarmId?)` to accept optional swarmId parameter and look up correct swarm config from map
- Updated guardrails hook to extract swarmId from agent name and pass to `getSwarmAgents(swarmId)` for correct fallback model resolution

## User-facing changes

**Previously**: In multi-swarm configs, model fallback resolution always consulted the last-processed swarm's config. If `fast` and `precise` swarms had different `fallback_models`, only the last swarm in config order would be used correctly — all other swarms would silently use wrong or missing fallback models.

**Now**: Each swarm's `fallback_models` are stored independently and resolved correctly at runtime, regardless of swarm iteration order.

Example fix:
```json
{
  "swarms": {
    "fast": {
      "agents": { "coder": { "fallback_models": ["fast/fallback"] } }
    },
    "precise": {
      "agents": { "coder": { "fallback_models": ["precise/fallback"] } }
    }
  }
}
```

With this config:
- Before fix: If `precise` was last, `fast_coder` would use `precise/fallback` (wrong)
- After fix: `fast_coder` uses `fast/fallback`, `precise_coder` uses `precise/fallback` (correct)

## Migration notes

None required — this is a pure bugfix. Existing configs continue to work; multi-swarm setups now get correct fallback behavior automatically.

## Discovery context

This pre-existing architectural gap was exposed by PR #1216 (fix: respect top-level agent config in swarms mode), which encouraged users to configure multiple named swarms. The bug became impactful once users had two or more swarms with different model fallback configs.

The root cause: module-level `_swarmAgents` variable was designed for single-slot use and never updated when multi-swarm support was added in earlier versions.

Related issue #1225: https://github.com/ZaxbyHub/opencode-swarm/issues/1225
