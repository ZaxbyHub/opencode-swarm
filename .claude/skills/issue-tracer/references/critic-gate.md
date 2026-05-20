# Independent Critic Gate

Use this reference in Phase 3 before presenting the plan to the user.

## Critic Mission

The critic is adversarial and independent. It does not improve the wording of the plan. It tries to prove that the plan would fail to fully close the issue.

The critic reviews only evidence and plan quality. It must not write production code.

## Preferred Invocation

If subagent delegation is available, launch a separate critic with this prompt:

```markdown
You are an independent critic reviewing an issue-tracer fix plan before implementation.

Your task is to find gaps, unwired functionality, unsupported assumptions, missed edge cases, missing tests, unsafe scope, and root-cause errors.

Read these artifacts:
- 01-issue-summary.md
- 02-reproduction.md
- 03-localization-log.md
- 04-root-cause.md
- 05-fix-plan.md

Also inspect any files referenced in the plan. Do not trust summaries if the underlying code is available.

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

If no independent subagent is available, create `06-critic-review.md` with:

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

Write the full fallback review in one pass. Do not leave a stub artifact containing only the fallback disclosure.

## Required Critic Questions

The critic must answer:

1. Does the reproduction actually match the issue, or did the tracer reproduce a nearby symptom?
2. Is the claimed root cause necessary and sufficient?
3. Could the fix make the test pass while leaving the real runtime path unwired?
4. Are all callers/importers/entry points covered?
5. Are config defaults, feature flags, docs, and generated code surfaces considered?
6. Are both positive and negative tests included?
7. Are boundary cases covered: null, empty, missing, malformed, duplicate, concurrent, retry, cancellation, timeout, permission denied, and partial failure?
8. Does the patch preserve public API and backward compatibility?
9. Does the plan avoid broad refactors and unrelated cleanup?
10. Is rollback straightforward?

## Verdict Semantics

- `APPROVE`: No blocker remains. Minor suggestions may exist, but implementation can proceed after user approval.
- `NEEDS_REVISION`: The plan is probably fixable, but one or more revisions are required before user approval.
- `BLOCKED`: The plan lacks enough evidence, has a wrong root cause, requires a product decision, or needs unavailable context.

## Revision Rules

If the critic returns `NEEDS_REVISION` or `BLOCKED`:

1. Revise `05-fix-plan.md`.
2. Record the response to every critic item.
3. Re-run the critic or perform a second critic pass.
4. Do not present the plan as ready until blockers are resolved or explicitly escalated.
