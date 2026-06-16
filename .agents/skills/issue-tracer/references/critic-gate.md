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

## Implementation Review (Phase 4.5)

Use this section AFTER the fix is implemented and validated, to challenge the actual diff. It is independent of the Phase 3 plan critic: the plan critic challenges the plan; this reviewer challenges the real patch and its evidence. The context that wrote the patch must not be the only one that approves it.

### Reviewer Mission

The reviewer is adversarial and independent. Its job is to find a concrete case where the implemented patch is wrong, incomplete, overfits the regression test, leaves a runtime path unwired, or regresses an existing contract. It verifies claims against the real code and the captured command output — it does not trust the implementer's narrative. It must not rewrite production code.

### Preferred Invocation

If a separate subagent/delegation mechanism is available and authorized, run the reviewer with this prompt, giving it the diff and artifacts, not your reasoning narrative:

```markdown
You are an independent implementation reviewer for an issue-tracer fix that has already been implemented and validated. Your job is to REFUTE it, not to agree with it.

Inputs:
- the full diff (e.g. `git diff origin/main...HEAD`)
- 04-root-cause.md, 07-approved-plan.md, 08-test-results.md
- any files the diff touches (open them; do not trust summaries)

Find, with concrete evidence:
- a specific input/environment/caller/sequence where the patch is wrong or incomplete
- whether the new test would still pass if the bug were only partially fixed (overfitting / plausible-not-correct)
- any changed path that is not wired into the real runtime path
- any regressed public API, CLI, UI, config, persistence, or concurrency contract
- any "passed"/"validated" claim in 08-test-results.md not backed by a shown command + output

Return exactly:

# Implementation Review

## Verdict
APPROVE / NEEDS_REVISION / BLOCKED

## Correctness vs Root Cause
[Does the diff fix the documented root cause, or only the symptom/test?]

## Overfitting Check
[Could the patch be wrong while still passing the new test? Show how or why not.]

## Unwired / Runtime-Path Gaps
[Entry points, exports, callers, config, routes, CLI/UI paths not connected.]

## Contract & Regression Risk
[Public API, backward-compat, migration, concurrency, security.]

## Evidence Integrity
[Validation claims not backed by captured command output.]

## Required Revisions
- [Required change or NONE]
```

### Fallback Invocation

If no independent subagent is available, write `08b-implementation-review.md` using the same headings in one clean adversarial pass, prefixed with "Fallback self-review: independent reviewer unavailable." A self-review is weaker than an independent context — disclose it. Do not leave a stub containing only the disclosure.

### Verdict Semantics

- `APPROVE`: no blocker remains; closure may proceed.
- `NEEDS_REVISION`: one or more code or evidence changes are required before closure.
- `BLOCKED`: the patch does not address the root cause, overfits, or needs context/decision the reviewer lacks.

### Revision Rules

Resolve every `NEEDS_REVISION`/`BLOCKED` item by changing code or capturing real evidence, then re-review. Do not downgrade a blocker by rewording it. Record the response to every reviewer item in `08b-implementation-review.md`.

## Final Critic (Phase 4.6)

Use this section after the implementation reviewer has approved the current diff. This critic challenges the entire completion claim, including code, tests, docs, release notes, package metadata, validation evidence, and the reviewer artifact.

### Preferred Invocation

If subagent delegation is available, launch a separate critic with this prompt:

```markdown
You are the final critic for an issue-tracer implementation that already passed implementation review. Your job is to prove the completion claim is still wrong.

Inputs:
- the current full diff
- 01-issue-summary.md through 08b-implementation-review.md
- 08-test-results.md with captured command output
- all changed files

Check:
- the reviewer approval is on the latest diff, not an earlier state
- every NEEDS_REVISION/BLOCKED reviewer item was actually fixed and re-reviewed
- docs, release notes, package metadata, CLI/API claims, and tests match the implemented behavior
- validation claims are backed by commands and output
- no work was silently deferred, scoped out, or left unwired
- no edit occurred after the latest reviewer approval

Return exactly:

# Final Critic

## Verdict
APPROVE / NEEDS_REVISION / BLOCKED

## Completion Integrity
[Does the current diff satisfy the issue and no-gap checklist?]

## Review Freshness
[Did reviewer approval happen after the latest edit?]

## Drift Check
[Any mismatch among code, tests, docs, release notes, package metadata, and final summary?]

## Evidence Integrity
[Any unbacked validation or correctness claim?]

## Required Revisions
- [Required change or NONE]
```

### Fallback Invocation

If no independent critic is available, write `09-final-critic.md` with the same headings in one clean adversarial pass, prefixed with "Fallback final critic: independent critic unavailable." Do not leave a stub artifact containing only the disclosure.

### Verdict Semantics

- `APPROVE`: no blocker remains; closure may proceed if no later edit happens.
- `NEEDS_REVISION`: one or more code, docs, tests, or evidence changes are required before closure.
- `BLOCKED`: the completion claim depends on missing context or an unresolved decision.

Any edit after final critic approval invalidates the approval. Re-run implementation review when the edit changes the diff, then re-run the final critic.
