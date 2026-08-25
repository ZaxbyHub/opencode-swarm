# Invocation failure and Full-Auto recovery hardening

## What changed

- Unified provider, shell, filesystem, Git, policy, validation, cancellation, and deadline outcomes behind a structured, source-aware failure contract.
- Made retry/denial circuits semantic, action-local, bounded, and recoverable without weakening sandbox, containment, or destructive-command enforcement.
- Scoped model fallback to the exact session, invocation, swarm, and role, and applied fallback models at real SDK request boundaries instead of mutating shared agent configuration.
- Made Full-Auto delegation risk capability-aware, bounded critic oversight with one total deadline, added supervised recovery controls, and required correlated structured evidence before severe subagent claims can durably pause a run.
- Replaced the remaining runtime built-in abort-timeout sites with one cross-platform aborting deadline helper to eliminate the Windows/Bun hang class tracked by #1964.

## Why

Previously, unrelated delegations could collide, arbitrary command output could trigger fatal classifications, one failure could block an entire invocation, model fallback could leak or remain unwired, and Full-Auto could become stuck or trust free-form prose as durable security evidence.

## Migration

Existing configuration remains valid. Full-Auto gains bounded oversight deadline defaults and preserves strict-mode behavior. Circuit and model-override authority is in-memory and resets at documented invocation/session boundaries; user agent model configuration is never rewritten.

## Breaking changes and caveats

No intentional public API break. Recovery resets are now exact-action and audited; a broad session-wide hard-stop clear is intentionally no longer the control model. High-risk Full-Auto actions remain denied until their exact policy/sandbox condition is repaired and re-reviewed.
