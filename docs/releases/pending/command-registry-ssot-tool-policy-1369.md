# Command Registry SSOT — toolPolicy Classification and TUI Discoverability

## What changed

### `toolPolicy` and `toolNoArgs` fields on `CommandEntry` (`src/commands/registry.ts`)

Every entry in `COMMAND_REGISTRY` now carries two new metadata fields:

- **`toolPolicy`** — a 4-value enum classifying how a command may be invoked through the `swarm_command` chat tool:
  - `agent` — callable by the agent via `swarm_command`
  - `human-only` — the agent is told to surface the request to the user rather than executing it; the Bash guardrail blocks CLI bypass
  - `restricted` — same refusal path as `human-only` (both drive `HUMAN_ONLY_SWARM_COMMANDS`)
  - `none` — not available through `swarm_command`
- **`toolNoArgs`** — `true` for commands that reject any arguments through `swarm_command`

The 5 newly TUI-discoverable commands and their classifications:

| Command | toolPolicy | Previously |
|---|---|---|
| `pr subscribe` | `human-only` | not in TUI |
| `pr unsubscribe` | `human-only` | not in TUI |
| `pr status` | `agent` | not in TUI |
| `learning` | `human-only` | not in TUI |
| `post-mortem` | `human-only` | not in TUI |

### Derived policy sets (`src/commands/tool-policy.ts`)

All 4 policy-gated sets are now **derived** from `COMMAND_REGISTRY` via lazy `Proxy` initialization (breaking the circular dependency with `registry.ts`):

- `SWARM_COMMAND_TOOL_COMMANDS` — union of `agent` + `human-only`; drives `z.enum` for tool input
- `SWARM_COMMAND_TOOL_ALLOWLIST` — `agent`-policy commands only
- `HUMAN_ONLY_SWARM_COMMANDS` — `human-only` + `restricted`; drives chat-tool refusal + Bash guardrail human-only set
- `NO_ARGS` — `toolNoArgs: true` commands

Hand-maintained literal sets were removed. `classifySwarmCommandToolUse` and `classifySwarmCommandChatFallbackUse` logic is unchanged — only the data source changed.

### Registry-derived TUI description (`src/index.ts`)

The `swarm` command description string (shown to the LLM in the OpenCode TUI) is now derived from `VALID_COMMANDS` at plugin init, filtering to standalone (non-alias, non-deprecated, non-subcommand) entries. Previously it was a hardcoded string.

5 new TUI shortcut entries were added so weaker models (Haiku-class) can discover `pr subscribe`, `pr unsubscribe`, `pr status`, `learning`, and `post-mortem` directly in the command picker without needing to know the `/swarm` prefix.

### Bash guardrail human-only set (`src/hooks/guardrails/tool-before.ts`)

`GUARDRAIL_HUMAN_ONLY_COMMANDS` is now derived from `HUMAN_ONLY_SWARM_COMMANDS` (which is itself derived from `COMMAND_REGISTRY`), replacing a parallel hand-maintained list. The regex for compound command matching (`pr subscribe`, `pr unsubscribe`) was extended to handle the two-word form correctly.

### Load-time validation (`src/commands/registry.ts`)

`validateToolPolicy()` runs at module load time and emits a non-fatal warning for any `COMMAND_REGISTRY` entry that is missing a `toolPolicy` classification, ensuring new commands without classification are visible at startup rather than silently falling through.

## Why

`COMMAND_REGISTRY` is the natural single source of truth for command metadata. Before this change, the tool-policy allowlist, human-only set, TUI description, and Bash guardrail human-only set were all independently hand-maintained — a partial update to any one of them created silent inconsistencies (e.g., a command in the allowlist but not in the TUI list, or vice versa). The comprehensive bidirectional parity test (`registration-parity.test.ts`) now prevents that class of regression.

The 4-value `toolPolicy` enum also makes the distinction between `human-only` (agent surfaces to user, Bash guardrail blocks CLI bypass) and `restricted` (same refusal, future separation) explicit rather than implicit.

## Migration

No user-facing migration needed. All changes are internal. Users who have cached the plugin binary may need to re-fetch to pick up the updated TUI discoverability.

## Invariant audit

- **1 (plugin init)** — `validateToolPolicy` is a synchronous in-process loop; `lazySet`/`lazyArray` defer all filtering to first access (after init completes); no new init-path I/O
- **3 (subprocesses)** — no new subprocess calls
- **4 (.swarm containment)** — no new `.swarm/` paths written by these changes
- **5 (plan durability)** — not touched
- **6 (test_runner safety)** — `MAX_SAFE_TEST_FILES` respected; `registration-parity.test.ts` is a unit test, not a broad `test_runner` scope
- **7 (test writing)** — `registry.tool-policy.test.ts` (new) and `registration-parity.test.ts` (updated) use `bun:test`; `lazySet`/`lazyArray` are synchronous pure functions with no `mock.module` leaks
- **8 (session state)** — not touched
- **9 (guardrails/retry)** — `GUARDRAIL_HUMAN_ONLY_COMMANDS` now derived; same runtime behavior
- **10 (chat/system msg)** — command description string is now derived; same shape and content for LLM
- **11 (tool registration)** — no new tools registered; `swarm_command` tool policy sets are derived, not hand-maintained
- **12 (release/cache)** — `dist/` not committed; `package-check` will validate the plugin shape post-build
