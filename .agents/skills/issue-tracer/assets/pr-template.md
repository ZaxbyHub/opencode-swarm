# PR Description Template

## Root Cause

[One paragraph explaining what was broken, where, and why. Include file paths, symbols, line ranges, and triggering conditions.]

## Fix

[Concise description of the minimal patch and why it is necessary and sufficient.]

- [Specific code change]
- [Specific code change]
- [Specific code change]

## Tests

- Regression test: `[command]` -> PASS
- Impacted suite: `[command]` -> PASS
- Lint/type/build/security checks: `[commands]` -> PASS

## Regression Protection

- [New/updated test path and scenario]
- [Negative/boundary/adversarial case if relevant]
- [Test drift review result]

## Invariant Audit

- 1 (plugin init): touched / not touched - <evidence>
- 2 (runtime portability): touched / not touched - <evidence>
- 3 (subprocesses): touched / not touched - <evidence>
- 4 (.swarm containment): touched / not touched - <evidence>
- 5 (plan durability): touched / not touched - <evidence>
- 6 (test_runner safety): touched / not touched - <evidence>
- 7 (test writing): touched / not touched - <evidence>
- 8 (session state): touched / not touched - <evidence>
- 9 (guardrails/retry): touched / not touched - <evidence>
- 10 (chat/system msg): touched / not touched - <evidence>
- 11 (tool registration): touched / not touched - <evidence>
- 12 (release/cache): touched / not touched - <evidence>

## Risk and Rollback

- Risk level: [low/medium/high]
- Rollback: [revert commit / disable flag / restore config / migration rollback]
- Residual risk: [none or explicit risk]

## Issue Closure

Closes #[issue-number]
