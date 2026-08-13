# Context budget handoff feedback hardening

## What

Live context-window state now preserves the host's trimmed model and provider
spelling for case-sensitive `context_budget.model_limits` lookup and diagnostic
reporting while comparing identities case-insensitively. A numeric live-window
sample without model/provider identity can seed a new session, but cannot
overwrite an existing exact binding. Production-wiring regressions now boot the
real plugin and cover registered subagent defaults, primary UI authority, and
incoming-model guardrail selection.

## Why

Lowercasing the stored host identity could miss a mixed-case user override and
report a model name the host never supplied. An identity-less system-transform
sample could also erase a valid model binding and make later message transforms
relay a generic denominator under the wrong identity.

## Migration

No configuration changes are required.
