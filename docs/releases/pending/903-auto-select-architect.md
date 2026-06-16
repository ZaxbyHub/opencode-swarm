# feat(config): add auto_select_architect option to auto-select swarm architect on launch (#903)

## What changed

Added a new top-level config option `auto_select_architect` that controls whether the swarm architect is automatically selected as the active agent instead of OpenCode's built-in `build`/`plan` agents.

| Value | Effect |
|-------|--------|
| `false` (default) | No auto-select — user picks the architect manually |
| `true` | Disable `build` and `plan` so the swarm architect is the primary selectable agent (build and plan are disabled) |
| `"<architect_name>"` | Same as `true`, but targets a specific architect by name (e.g. `"mega_architect"`) — all other architects are demoted to subagent |

Multi-swarm integration tests added per AGENTS.md invariant 11 (primary/subagent selection changes must include a multi-swarm `swarms: { local: ..., mega: ... }` test asserting at least one prefixed agent is `mode: 'primary'`).

## Why

Without this option, OpenCode's built-in `Build` agent is auto-selected on launch and users must manually switch to the swarm architect every session. With `auto_select_architect: true`, the plugin disables the competing built-in agents in the `config:` hook so the swarm architect is the only primary agent available — OpenCode then auto-selects it automatically.

## Migration steps

None required. The default value is `false` and existing configurations are unaffected. To opt in, add to your `.opencode/opencode-swarm.json` config (or `~/.config/opencode/opencode-swarm.json` for a global default):

```json
{
  "auto_select_architect": true
}
```

Or, for a specific architect in a multi-swarm setup:

```json
{
  "auto_select_architect": "mega_architect"
}
```

## Breaking changes

None.
