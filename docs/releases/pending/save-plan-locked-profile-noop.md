# Save Plan Locked Profile No-Op Retries

## What changed

- `save_plan` now accepts repeated `execution_profile` input when it is semantically identical to the already locked profile.
- Attempts to change a locked profile still fail closed unless `reset_statuses: true` starts a fresh plan.

## Why

Agents can retry a plan save after an `EXECUTION_PROFILE_LOCKED` response while still including the same locked profile in the tool call. Rejecting a no-op profile repeat causes avoidable retry loops even though the plan-scoped concurrency settings are unchanged.

## Migration steps

- No migration required.

## Breaking changes

- None.

## Known caveats

- Locked profiles remain immutable. Only idempotent no-op repeats are accepted.
