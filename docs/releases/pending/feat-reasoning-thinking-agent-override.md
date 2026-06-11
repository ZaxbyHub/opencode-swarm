## feat(config): support `reasoning` and `thinking` fields in AgentOverrideConfigSchema

**What changed.** `AgentOverrideConfigSchema` (`src/config/schema.ts`) now
accepts two new optional typed fields per agent override:

- `reasoning: { effort?: "low" | "medium" | "high" | "max" }` — for
  OpenAI-compatible models that support reasoning-effort control
  (e.g. `gpt-5.x-codex`).
- `thinking: { type?: "enabled" | "disabled"; budget_tokens?: number }` — for
  Anthropic models that support extended thinking
  (e.g. `claude-opus-4`).

`applyOverrides()` (`src/agents/index.ts`) now copies both fields from the
swarm agent config into `agent.config` so they reach the OpenCode runtime.

**Why.** Zod strips unknown keys by default. Any `reasoning` or `thinking`
block a user added to their config was silently discarded during parse, so
extended-thinking / reasoning-effort configuration was completely non-functional
without any error, warning, or indication of the problem.

**Impact.** Users who configure extended thinking or reasoning effort via
`swarms.<id>.agents.<role>` or top-level `agents.<role>` will now have those
settings honoured at runtime.

**Migration.** No breaking change. Existing configs without these fields are
unaffected. Add `reasoning` or `thinking` blocks directly in your agent
override:

```json
{
  "swarms": {
    "paid": {
      "agents": {
        "critic": {
          "model": "openai/gpt-5.3-codex",
          "reasoning": { "effort": "high" }
        },
        "reviewer": {
          "model": "anthropic/claude-opus-4-6",
          "thinking": { "type": "enabled", "budget_tokens": 10000 }
        }
      }
    }
  }
}
```
