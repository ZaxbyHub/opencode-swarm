# Fix: config-doctor no longer reports top-level `agents` as deprecated

## What changed

`config-doctor` warned `The "agents" field is deprecated. Use "swarms" instead` and proposed removing the key. The key is not deprecated: it is documented as the per-agent override for the default swarm (`docs/configuration.md`), it is merged into every swarm at runtime (`src/agents/index.ts`), and the v7.11.0 notes name `agents.<role>.model` as where to set a model. Following the suggestion would delete working configuration.

An object-valued `agents` now produces no finding. A non-object value (for example a string, number or array) is still rejected: config loading discards it and `config-doctor` reports `invalid-config-value` (error). The `invalid-agents-type` check in `config-doctor` is a defense-in-depth guard that keeps the key's validation case, which the schema-introspection test requires for every top-level key.

## Why

Closes #3463.
