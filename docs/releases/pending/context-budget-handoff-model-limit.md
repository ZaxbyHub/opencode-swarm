# Context budget handoff model limits

## What

Context-budget enforcement now uses the incoming subagent's actual registered
model on the first turn after a handoff, before that agent has emitted an
assistant message. This includes explicit overrides, runtime fallbacks, factory
defaults, and inherited role defaults. Primary agents continue to use live
assistant metadata because OpenCode's UI controls their model. Exact named-swarm
targets are resolved through the same model-precedence logic used by delegation
accounting and adversarial-pair checks. Low-capability guardrails prompt trimming
uses that incoming model too, and agent-switch history is isolated per session
with bounded storage. Relayed live context windows are now bound to the exact
model and provider that reported them, so a same-session handoff cannot reuse
the outgoing model's denominator. Context pruning, knowledge injection, and
context-status reporting all use the current live model identity when the UI
controls selection. A switch
between two named-swarm agents of the same role is now treated as a real agent
switch when `enforce_on_agent_switch` is enabled.

## Why

The hook previously derived its context limit from the most recent assistant
message, which still belonged to the outgoing agent during a handoff. Moving
from a large-context model to a smaller one could therefore skip pruning and
let the provider reject the request for exceeding its token limit. Related
global switch state and first-matching-swarm lookup could also mix independent
sessions or choose another swarm's model.

## Migration

No configuration changes are required. Existing `agents.*.model`,
`swarms.*.agents.*.model`, `fallback_models`, factory defaults, and
`context_budget.model_limits` settings are used.

## Caveats

When the incoming target is primary, has a malformed explicit model string, or
does not match a registered swarm target, context-budget preserves the prior
assistant-metadata fallback instead of guessing the OpenCode UI model.
