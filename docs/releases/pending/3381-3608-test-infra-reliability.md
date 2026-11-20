# Test-infra reliability: cross-file co-run pollution fix + acceptance-validator hardening

## What

Fixes the cross-file test-process pollution that made `guardrails-swarm-path-guard.test.ts` and
`guardrails.test.ts` fail 17-58 ALLOWED legs only when co-run with `guardrails-modified-files.test.ts`
(issue #3608), and the three stale-acceptance-validator quirks tracked in #3381.

- `src/hooks/guardrails/execution-stall.ts`: the module-level `stallStates` + `pendingDispatchRoles`
  registries are now cleared by `resetSwarmState()` (via a new `resetExecutionStallState()` export),
  mirroring the route-invalidation precedent. The Task-dispatch path arms an episode that previously
  survived reset and denied later sessions' allow-legs at the 60-call threshold with an empty error
  message.
- `src/hooks/delegation-gate.ts`: `validateCoderReviewerAcceptanceField` now strips Cc/Cf code points
  before the emptiness check (U+200B no longer counts as content), and the gate validates the first
  field that independently satisfies the validator so a bare `ACCEPTANCE:` header cannot borrow the
  next field's text. Auto-injection semantics unchanged.
- `tests/helpers/isolated-test-env.ts`: corrected the docblock that claimed `os.homedir()` ignores
  `process.env` under Bun (falsified on Bun 1.3.14; it follows redirected HOME/USERPROFILE).
- `tests/unit/hooks/guardrails-native-agents.test.ts`: uses a sandboxed temp root per test instead of
  `os.tmpdir()` itself, so it no longer writes `%TEMP%\.swarm\session\shell-audit.jsonl` and
  destabilizes every later bun process on the host.

New tests: `tests/unit/hooks/execution-stall-reset-state-3608.test.ts`,
`tests/unit/helpers/isolated-test-env-homedir.test.ts`,
`tests/unit/hooks/delegation-gate-acceptance-validator-hardening.test.ts`.

## Why

The #3608 pollution was a real test-infra wedge: every session whose blast-radius census included
the affected suites re-paid a ~10-minute classification cost and risked misattributing the 17-58
failures to its own delta. The #3381 items were verified fail-open conditions (validator returning
`{valid:true}` on zero-width content and on field-borrowed headers) on a pre-dispatch gate. Both
issues are collated into one PR per the user's authorization; all 7 frozen acceptance checks pass
at the shipped head, with two plan-critic rounds of remediation.