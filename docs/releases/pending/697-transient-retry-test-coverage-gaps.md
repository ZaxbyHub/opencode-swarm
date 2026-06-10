# Test coverage gaps for transient retry (issue #697)

## What changed

Added targeted test coverage for two previously untested scenarios identified
in the follow-up to PR #694:

### Snapshot migration (v6.86.14 deserialization)

`tests/unit/session/snapshot-reader.test.ts` — new describe block
`deserializeAgentSession - transientRetryCount migration (v6.86.14)` with 4 tests:

- Old snapshot window without `transientRetryCount` field defaults to `0` after
  `deserializeAgentSession`, exercising the migration guard added in v6.86.14.
- Window with `transientRetryCount: 3` preserves the persisted value.
- Window with `transientRetryCount: 0` explicitly keeps `0` (not confused with
  the absent-field fallback path).
- Session with mixed windows (one absent, one present) migrates both correctly.

### Per-agent `max_transient_retries` override via `resolveGuardrailsConfig`

`tests/unit/config/guardrails-profile.test.ts` — new describe block
`resolveGuardrailsConfig max_transient_retries per-agent override (v6.86.14)` with
6 tests:

- Base config `max_transient_retries` flows through when no profile override exists.
- Per-agent profile override wins (`profiles: { coder: { max_transient_retries: 10 } }`).
- Setting `max_transient_retries: 0` in a profile disables the transient bypass for
  that agent.
- Unknown agent with no profile inherits base config value.
- Unknown agent with a matching profile uses the profile value.
- Prefixed agent name (`local_coder`) resolves through canonical name stripping to
  the `coder` profile override.

## Why

Issue #697 identified these two LOW-priority coverage gaps after PR #694 merged.
The HIGH and MEDIUM items were already covered by existing tests in
`tests/unit/hooks/guardrails-error-classification.test.ts`.

## Migration steps

None. Test-only change — no production code modified.

## Breaking changes

None.

## Known caveats

None.
