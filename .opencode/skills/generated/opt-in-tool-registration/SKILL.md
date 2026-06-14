---
name: opt-in-tool-registration
description: >
  Pattern for adding opt-in/gated tools to opencode-swarm that are disabled by
  default and activated via config flag. Covers tool metadata registration,
  manifest handler wiring, separate tool map, conditional merge, execute()
  guard ordering, and gating tests.
effort: medium
generated_from_knowledge: []
source_knowledge_ids: []
generated_at: 2026-06-14T16:50:00Z
confidence: 0.5
status: active
version: 2
skill_origin: generated
provenance_note: >
  Original source knowledge IDs could not be recovered from the knowledge base.
  Metadata backfilled manually; body content preserved from the prior active revision.
---

# Opt-In Tool Registration Pattern

Activates when adding new tools that are gated behind a config flag (disabled by
default). Use this pattern to ensure tools are invisible when the feature is off
and properly guarded when on.

## When to Use

- Adding a new set of tools behind a feature flag (e.g., `external_skills`,
  `memory`, `curation_enabled`)
- Registering tools that should not appear in agent menus until explicitly
  enabled
- Any tool group where the default state is "off" and the user must opt in

## Pattern Overview

The opt-in tool registration pattern has four components:

1. **Separate tool map** — isolated constant in `constants.ts`
2. **Conditional merge** — merge into agent configs only when enabled
3. **Execute guard** — config check BEFORE argument validation in `execute()`
4. **Gating tests** — verify absent/present/disabled-message behavior

## Step 1 — Create the Tool Files

Create tool files in `src/tools/` following the standard `createSwarmTool`
pattern. Each tool's `execute()` function must:

1. Load the relevant config section
2. Check if the feature is enabled
3. Return the disabled message if not enabled
4. **Only then** validate arguments

```typescript
// src/tools/my-feature-tool.ts
export const myFeatureTool = createSwarmTool({
  name: "my_feature_tool",
  description: "...",
  parameters: { ... },
  execute: async (args, ctx) => {
    // 1. Load config — MUST come first
    //    (example: replace with actual config loading for your feature)
    const config = resolveConfig(ctx.directory).my_feature;
    if (!config?.enabled) {
      return {
        content: [{ type: "text", text: "My feature is not enabled. ..." }],
      };
    }

    // 2. Validate arguments — AFTER enabled check
    const parsed = mySchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid args: ${parsed.error.message}` }] };
    }

    // 3. Business logic
    ...
  },
});
```

**Critical**: The enabled check MUST precede argument validation. Otherwise,
calling with empty args while disabled returns validation errors instead of the
disabled message. This is the most common bug in opt-in tool implementations.

## Step 2 — Create the Agent Tool Map

Add a separate constant in `src/config/constants.ts`:

```typescript
// DO NOT add to AGENT_TOOL_MAP directly
export const MY_FEATURE_AGENT_TOOL_MAP: Record<string, string[]> = {
  architect: ["my_feature_tool", ...],
  coder: [...],
  reviewer: [...],
  // Only include agents that need the tools
};
```

Export from `constants.ts`. `TOOL_NAMES` is derived automatically from
`TOOL_METADATA` in `src/tools/tool-metadata.ts` — do not edit
`src/tools/tool-names.ts` directly (it is a re-export facade).

## Step 3 — Conditional Merge in Agent Config Builder

In the agent config builder (typically `src/agents/index.ts` or similar),
conditionally merge the opt-in map:

```typescript
import { MY_FEATURE_AGENT_TOOL_MAP } from "./constants";

function buildAgentConfigs(config: PluginConfig) {
  // ... base config building ...

  // Conditional merge
  if (config.my_feature?.enabled) {
    for (const [role, tools] of Object.entries(MY_FEATURE_AGENT_TOOL_MAP)) {
      if (agentConfigs[role]) {
        agentConfigs[role].tools = [...agentConfigs[role].tools, ...tools];
      }
    }
  }

  return agentConfigs;
}
```

## Step 4 — Register in Tool Metadata and Manifest

The registration chain has two compile-checked files:

1. **`src/tools/tool-metadata.ts`** — Add a `TOOL_METADATA` entry with the tool's
   name, description, and default agents. This is the single source of truth for
   tool registration metadata. `ToolName`, `TOOL_NAMES`, and `TOOL_NAME_SET` are
   derived automatically.

2. **`src/tools/manifest.ts`** — Add a lazy thunk handler (`() => tool`) for the
   tool. This file is compile-checked against `TOOL_METADATA`: a missing entry in
   either file is a compile error.

Registration is always present regardless of enabled state. The tool is
registered but non-functional when disabled (returns the disabled message).

## Step 5 — Write Gating Tests

Three test categories are mandatory:

### 5a. Tools absent when disabled

```typescript
test("my_feature tools not in agent config when disabled", () => {
  const config = { my_feature: { enabled: false } };
  const agents = buildAgentConfigs(config);
  for (const agent of Object.values(agents)) {
    expect(agent.tools).not.toContain("my_feature_tool");
  }
});
```

### 5b. Tools present when enabled

```typescript
test("my_feature tools in agent config when enabled", () => {
  const config = { my_feature: { enabled: true } };
  const agents = buildAgentConfigs(config);
  expect(agents.architect.tools).toContain("my_feature_tool");
});
```

### 5c. Disabled message before validation errors

```typescript
test("disabled tool returns disabled message, not validation error", async () => {
  const config = { my_feature: { enabled: false } };
  const result = await myFeatureTool.execute({}, mockCtx(config));
  expect(result.content[0].text).toContain("not enabled");
  expect(result.content[0].text).not.toContain("Invalid args");
});
```

## Step 6 — Export and Wire

Complete the registration chain:

1. Add a `TOOL_METADATA` entry in `src/tools/tool-metadata.ts` (name, description, agents)
2. Add a lazy thunk handler in `src/tools/manifest.ts` (compile-checked against metadata)
3. Add the tool name to the opt-in map in `src/config/constants.ts`
4. Add to the conditional merge in agent config builder (typically `src/agents/index.ts`)
5. Add to help/documentation surfaces
6. Write tests covering all 5a/5b/5c categories

Run `tests/unit/config/*.test.ts` and `/swarm doctor tools` after any changes.

## Common Failures

### Enabled check after validation

Symptom: Calling tool with empty args while disabled returns "Invalid args"
instead of "Feature not enabled".
Fix: Move the config load + enabled check to the top of `execute()`.

### Tools in base AGENT_TOOL_MAP

Symptom: Tools appear in agent menus even when disabled.
Fix: Use a separate opt-in map, not the base `AGENT_TOOL_MAP`.

### Missing tool-metadata entry

Symptom: `doctor tools` reports unknown tool name or compile error in manifest.
Fix: Add the tool entry to `TOOL_METADATA` in `src/tools/tool-metadata.ts`.
The `ToolName` type and `TOOL_NAMES` are derived automatically from this file.

### Missing manifest handler

Symptom: Compile error in `src/tools/manifest.ts` — handler map does not satisfy
`Record<ToolName, ...>`.
Fix: Add a lazy thunk handler for the tool in `src/tools/manifest.ts`.

## Source Knowledge

- Config check must precede argument validation in opt-in tool execute() (swarm knowledge)
- TOCTOU re-validation uses strictest trust level at promotion gate (swarm knowledge)
- AGENTS.md invariant 11: Tool registration + agent-map coherence
