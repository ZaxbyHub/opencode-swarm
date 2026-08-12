# Context budget handoff model limits

## What

Context-budget enforcement now uses the incoming agent's explicitly configured
model on the first turn after a handoff, before that agent has emitted an
assistant message. Exact named-swarm targets are resolved through the same
model-precedence logic used by delegation accounting and adversarial-pair
checks. Low-capability guardrails prompt trimming uses that incoming model too,
and agent-switch history is isolated per session with bounded storage.

## Why

The hook previously derived its context limit from the most recent assistant
message, which still belonged to the outgoing agent during a handoff. Moving
from a large-context model to a smaller one could therefore skip pruning and
let the provider reject the request for exceeding its token limit. Related
global switch state and first-matching-swarm lookup could also mix independent
sessions or choose another swarm's model.

## Migration

No configuration changes are required. Existing `agents.*.model`,
`swarms.*.agents.*.model`, and `context_budget.model_limits` settings are used.

## Caveats

When the incoming target has no explicit model override, has a malformed model
string, or does not match a registered swarm target, context-budget preserves
the prior assistant-metadata fallback instead of guessing the OpenCode UI model.
