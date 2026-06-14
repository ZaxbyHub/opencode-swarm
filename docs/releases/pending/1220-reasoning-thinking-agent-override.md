# Agent override schema: `reasoning` and `thinking` fields

## What changed

`AgentOverrideConfigSchema` (in `src/config/schema.ts`) now declares two new
first-class optional fields on per-agent overrides:

- `reasoning: { effort: "low" | "medium" | "high" | "max" }` — provider-native
  extended-reasoning block (e.g. Anthropic Claude reasoning effort).
- `thinking: { type: "enabled" | "disabled", budget_tokens: number }` —
  provider-native extended-thinking block (e.g. Anthropic Claude extended
  thinking with a token budget).

`applyOverrides()` in `src/agents/index.ts` now reads these fields and
forwards them to the OpenCode SDK's `AgentConfig` (using a small cast, just
like the existing `variant` plumbing — the SDK's `AgentConfig` has an
open-ended index signature so this is structurally valid).

The default Zod strip behavior on unknown keys is preserved; we did NOT
switch to `.passthrough()`. Truly unknown fields (typos, future
provider-specific options) are still stripped to avoid leaking garbage into
the agent factory. A regression test in
`tests/unit/config/schema.test.ts` guards that contract.

## Why

Previously, any user that put `reasoning` or `thinking` in
`swarms.<id>.agents.<role>` (or top-level `agents.<role>`) had those fields
silently dropped at config parse time — Zod's default behavior is to strip
unknown keys. No error, no warning, no log. Extended thinking and
provider-native reasoning effort were therefore non-functional when
configured via swarm's per-agent override path. The issue (#1220) requested
either typed schema fields (preferred) or `.passthrough()` (escape hatch).
We chose typed fields for validation, autocomplete, and discoverability.

## Migration notes

- Users who already had `reasoning` or `thinking` blocks in their agent
  overrides: these will now actually take effect. Verify the configured
  behavior matches your intent — if you were relying on the old silent
  drop (e.g. as a placeholder for a feature your provider does not yet
  support), remove the field from your config to avoid surprises.
- The new fields are validated. Invalid `reasoning.effort` values (anything
  outside `low | medium | high | max`) and invalid `thinking.budget_tokens`
  values (non-positive) will now produce a Zod parse error at config load.
- `variant` (the swarm plugin's own reasoning-effort field) is unchanged
  and remains the recommended knob for OpenCode's generic variant hook.
  `reasoning.effort` is a separate, provider-native field. They are NOT
  synonymous and can be used together — the user controls how their
  provider interprets each.

## Budget guidance (FB-003)

The plugin does **not** impose a plugin-level upper bound on
`thinking.budget_tokens`. The swarm plugin is provider-agnostic and
treats this field as a provider-native pass-through: any cross-provider
hardcoded maximum would be an arbitrary product policy that could
reject legitimate values for some providers/models while still not
guaranteeing cost safety across all of them. Validation is intentionally
limited to positivity (rejecting zero and negative values).

Practical implications:

- **Provider/model limits still apply.** A budget that exceeds the
  provider's or model's maximum may be rejected, clamped, or otherwise
  constrained at the provider API. The plugin's surface cannot guarantee
  acceptance; consult your provider's current documentation for the
  selected model.
- **Thinking tokens are typically billable output/reasoning tokens.**
  Large budgets can materially increase cost even if the provider
  accepts them. The smallest budget that achieves the desired behavior
  is the safe default.
- **Interaction with `max_tokens` and other limits.** Some providers
  require `budget_tokens` to be compatible with the request's
  `max_tokens` and other constraints. If you set both, verify the
  combination against your provider's docs.
- **Typo / runaway-value protection is the user's responsibility.**
  The plugin does not catch `budget_tokens: 1e15` or similar mistakes;
  review your config before deploying. Future per-provider capability
  metadata (if added) could revisit this with provider-aware bounds.
