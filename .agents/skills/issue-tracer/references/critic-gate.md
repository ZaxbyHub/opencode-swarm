# Critic Gate

Use this reference before implementation or before presenting a plan as ready.

## Mission

The critic is adversarial. It tries to prove that the plan will fail to fully close the issue. It reviews evidence and plan quality, not prose style, and it does not write production code.

## Preferred Invocation

Use a separate critic context only if a subagent/delegation mechanism is available and the user/session has authorized it. Pass the trace artifacts and the plan, not your private conclusions.

Prompt:

```markdown
You are an independent critic reviewing an issue-tracer fix plan before implementation.

Find gaps, unwired functionality, unsupported assumptions, missed edge cases, missing tests, unsafe scope, and root-cause errors.

Read these artifacts:
- 01-issue-summary.md
- 02-reproduction.md
- 03-localization-log.md
- 04-root-cause.md
- 05-fix-plan.md

Also inspect any files referenced in the plan. Do not trust summaries if the underlying code is available. Do not edit files.

Return exactly:

# Critic Review

## Verdict
APPROVE / NEEDS_REVISION / BLOCKED

## Evidence Sufficiency
[Is root cause proven? What evidence is missing?]

## Plan Correctness
[Would the selected fix address the root cause?]

## Unwired Functionality
[Any entry point, export, caller, config, route, UI path, CLI path, docs path, or test path not connected?]

## Edge Cases
[Missed null/empty/error/concurrent/idempotent/security/backward-compat cases.]

## Test Gaps
[Positive, negative, regression, integration, fixture, drift, and adversarial gaps.]

## Scope Risk
[Overreach, underreach, public API, migration, external service, or rollout risks.]

## Required Revisions
- [Required change or NONE]
```

## Fallback Invocation

If no independent critic is available, create or report the same review with this disclosure:

```markdown
# Critic Review

Fallback self-critic: independent critic unavailable.

## Verdict
APPROVE / NEEDS_REVISION / BLOCKED

## Evidence Sufficiency
[Is root cause proven? What evidence is missing?]

## Plan Correctness
[Would the selected fix address the root cause?]

## Unwired Functionality
[Any entry point, export, caller, config, route, UI path, CLI path, docs path, or test path not connected?]

## Edge Cases
[Missed null/empty/error/concurrent/idempotent/security/backward-compat cases.]

## Test Gaps
[Positive, negative, regression, integration, fixture, drift, and adversarial gaps.]

## Scope Risk
[Overreach, underreach, public API, migration, external service, or rollout risks.]

## Required Revisions
- [Required change or NONE]
```

Write the full fallback review in one pass. Do not leave a stub artifact containing only the disclosure.

## Required Questions

The critic must answer:

1. Does reproduction match the issue, or only a nearby symptom?
2. Is the claimed root cause necessary and sufficient?
3. Could the fix make tests pass while leaving the real runtime path unwired?
4. Are all callers, importers, and entry points covered?
5. Are config defaults, feature flags, docs, generated code, and release surfaces considered?
6. Are positive and negative tests included?
7. Are boundary cases covered: null, empty, missing, malformed, duplicate, concurrent, retry, cancellation, timeout, permission denied, and partial failure?
8. Does the patch preserve public API and backward compatibility?
9. Does the plan avoid broad refactors and unrelated cleanup?
10. Is rollback straightforward?
11. For `opencode-swarm`, does the plan identify every touched invariant and concrete evidence needed for the PR audit?

## Verdict Semantics

- `APPROVE`: No blocker remains. Implementation may proceed when mode/user approval allows it.
- `NEEDS_REVISION`: The plan is probably fixable, but one or more revisions are required first.
- `BLOCKED`: The plan lacks evidence, has the wrong root cause, requires a product decision, or needs unavailable context.

If the critic returns `NEEDS_REVISION` or `BLOCKED`, revise the plan, record the response to every item, and re-run or repeat the critic pass before proceeding.
