# Independent Critic Gate

This reference drives three independent gates: the Phase 3 plan critic, the Phase 4.5 implementation review, and the Phase 4.6 final critic. Each is adversarial and independent — it does not improve wording; it tries to prove the work is not done. None of them writes production code.

Every verdict artifact records the exact commit SHA it examined (or, for an uncommitted tree, a diff hash such as `git diff | git hash-object --stdin`). Closure requires the final-approval SHA/hash to equal the shipped HEAD; a later edit invalidates the approval and re-runs the affected gate. Freshness is checked by comparing hashes, never by recollection.

Before any fallback pass: attempt the delegation mechanism and record the verbatim tool-call error, or quote the user/session text forbidding subagents. If authorization is merely unclear and the session is interactive, ask the user. Non-interactive sessions may fall back only with the recorded failure output, stated in the artifact.

## Plan Critic (Phase 3)

Use before presenting the plan to the user. The critic reviews only evidence and plan quality and tries to prove the plan would fail to fully close the issue and its defect class.

### Preferred Invocation

If subagent delegation is available, launch a separate critic with this prompt:

```markdown
You are an independent critic reviewing an issue-tracer fix plan before implementation.

Your task is to find gaps, unwired functionality, unsupported assumptions, missed edge cases, missing tests, unsafe scope, an under-scoped defect-class sweep, and root-cause errors.

Read these artifacts:
- 01-issue-summary.md
- 02-reproduction.md
- 03-localization-log.md
- 04-root-cause.md
- 05-fix-plan.md

Also inspect any files referenced in the plan. Do not trust summaries if the underlying code is available.

Return exactly:

# Critic Review

## Reviewed SHA / diff hash
[The commit SHA or diff hash of the tree/plan you examined.]

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

## Defect-Class Sweep
[Is the anticipated Phase 4.2 sweep scoped to the real class, or too narrow?]

## Test Gaps
[Positive, negative, regression, integration, fixture, drift, and adversarial gaps.]

## Scope Risk
[Overreach, underreach, public API, migration, external service, or rollout risks.]

## Required Revisions
- [Required change or NONE]
```

### Fallback Invocation

If no independent subagent is available, create `06-critic-review.md` with the same headings (including `## Reviewed SHA / diff hash`) in one clean adversarial pass, prefixed with "Fallback self-critic: independent critic unavailable." Do not leave a stub artifact containing only the disclosure.

### Required Critic Questions

The critic must answer:

1. Does the reproduction actually match the issue, or did the tracer reproduce a nearby symptom?
2. Is the claimed root cause necessary and sufficient?
3. Could the fix make the test pass while leaving the real runtime path unwired?
4. Are all callers/importers/entry points covered?
5. Are config defaults, feature flags, docs, and generated code surfaces considered?
6. Are both positive and negative tests included?
7. Are boundary cases covered: null, empty, missing, malformed, duplicate, concurrent, retry, cancellation, timeout, permission denied, and partial failure?
8. Does the patch preserve public API and backward compatibility?
9. Does the plan avoid broad refactors and unrelated cleanup? (The Phase 4.2 defect-class sweep is in-scope by definition and is NOT "unrelated cleanup".)
10. Is rollback straightforward?
11. If the fix's exact invocation depends on subtle CLI/subprocess/flag semantics (git flags, gitignore anchoring, shell globs), was the exact candidate invocation empirically verified in an isolated environment — not just asserted as correct?
12. If the fix scopes or restricts a destructive/broad-acting operation, was it checked against the real target's full blast radius (a dry-run against the actual environment), not only a minimal reproduction?

### Verdict Semantics

- `APPROVE`: No blocker remains. Implementation can proceed after user approval.
- `NEEDS_REVISION`: The plan is probably fixable, but one or more revisions are required before user approval.
- `BLOCKED`: The plan lacks enough evidence, has a wrong root cause, requires a product decision, or needs unavailable context.

### Revision Rules

If the critic returns `NEEDS_REVISION` or `BLOCKED`: revise `05-fix-plan.md`, record the response to every critic item, and re-run the critic. Do not present the plan as ready until blockers are resolved or explicitly escalated. **Loop bound:** after three revision cycles without convergence, stop and escalate to the user with both positions and the evidence. Never resolve a deadlock by rewording a blocker.

## Implementation Review (Phase 4.5)

Use AFTER the fix is implemented and validated, to challenge the actual diff. It is independent of the Phase 3 plan critic: the plan critic challenges the plan; this reviewer challenges the real patch and its evidence. The context that wrote the patch must not be the only context that approves it.

### Reviewer Mission

Find a concrete case where the implemented patch is wrong, incomplete, overfits the regression test, leaves a runtime path unwired, misses a defect-class sibling, or regresses an existing contract. Verify claims against the real code and captured command output — do not trust the implementer's narrative.

### Reviewer Inputs (strict)

The reviewer receives ONLY: the full diff, `04-root-cause.md`, `07-approved-plan.md`, `08-test-results.md`, `08a-recurrence-sweep.md`, and the files the diff touches. It is NOT given the implementer's `05-fix-plan.md` reasoning or `06-critic-review.md` narrative — those can anchor the reviewer to the implementer's framing. Open the touched files; do not trust summaries.

### Preferred Invocation

If subagent delegation is available, launch a separate reviewer with this prompt:

```markdown
You are an independent implementation reviewer for an issue-tracer fix that has already been implemented and validated. Your job is to REFUTE it, not to agree with it.

Inputs (and only these):
- the full diff (e.g. `git diff origin/<default-branch>...HEAD`)
- 04-root-cause.md, 07-approved-plan.md, 08-test-results.md, 08a-recurrence-sweep.md
- the files the diff touches (open them; do not trust summaries)

Find, with concrete evidence:
- a specific input/environment/caller/sequence where the patch is wrong or incomplete
- whether the new test would still pass if the bug were only partially fixed (overfitting / plausible-not-correct)
- any changed path that is not wired into the real runtime path
- any defect-class sibling the Phase 4.2 sweep missed or misdispositioned
- any regressed public API, CLI, UI, config, persistence, or concurrency contract
- any "passed"/"validated" claim not backed by a shown command + output
- if the fix depends on CLI/subprocess/flag semantics, independently re-run the exact invocation yourself and confirm the observed behavior matches the claim
- if the fix scopes a destructive/broad-acting operation, independently re-check it against the real target's full blast radius

Return exactly:

# Implementation Review

## Reviewed SHA / diff hash
[The commit SHA or diff hash you examined.]

## Verdict
APPROVE / NEEDS_REVISION / BLOCKED

## Correctness vs Root Cause
[Does the diff fix the documented root cause, or only the symptom/test?]

## Overfitting Check
[Could the patch be wrong while still passing the new test? Show how or why not.]

## Unwired / Runtime-Path Gaps
[Entry points, exports, callers, config, routes, CLI/UI paths not connected.]

## Defect-Class Sweep Integrity
[Did Phase 4.2 characterize the class correctly, sweep completely, and install a guardrail that bites?]

## Contract & Regression Risk
[Public API, backward-compat, migration, concurrency, security.]

## Evidence Integrity
[Validation claims not backed by captured command output.]

## Deferred / Scoped-Out / Unwired
[Any work silently deferred, scoped out, or left unwired. State NONE only if truly none.]

## Required Revisions
- [Required change or NONE]
```

### Fallback Invocation

If no independent subagent is available, write `08b-implementation-review.md` using the same headings (including `## Reviewed SHA / diff hash` and `## Deferred / Scoped-Out / Unwired`) in one clean adversarial pass, prefixed with "Fallback self-review: independent reviewer unavailable." Do not leave a stub containing only the disclosure.

### Verdict Semantics

- `APPROVE`: no blocker remains; closure may proceed.
- `NEEDS_REVISION`: one or more code or evidence changes are required before closure.
- `BLOCKED`: the patch does not address the root cause, overfits, or needs context/decision the reviewer lacks.

### Revision Rules

Resolve every `NEEDS_REVISION`/`BLOCKED` item by changing code or capturing real evidence, then re-review. Do not downgrade a blocker by rewording it. Record the response to every reviewer item in `08b-implementation-review.md`. **Loop bound:** after three reviewer/critic revision cycles without convergence, stop and escalate to the user with both positions and evidence.

## Final Critic (Phase 4.6)

Use after the implementation reviewer has approved the current diff. This critic challenges the entire completion claim, including code, tests, docs, release notes, package metadata, validation evidence, and the reviewer artifact.

### Preferred Invocation

If subagent delegation is available, launch a separate critic with this prompt:

```markdown
You are the final critic for an issue-tracer implementation that already passed implementation review. Your job is to prove the completion claim is still wrong.

Inputs:
- the current full diff
- 01-issue-summary.md through 08b-implementation-review.md, including 08a-recurrence-sweep.md
- 08-test-results.md with captured command output
- all changed files

Check:
- the reviewer approval is on the latest diff (matching SHA/hash), not an earlier state
- every NEEDS_REVISION/BLOCKED reviewer item was actually fixed and re-reviewed
- docs, release notes, package metadata, CLI/API claims, and tests match the implemented behavior
- the Phase 4.2 guardrail exists and demonstrably bites
- every acceptance criterion maps to concrete evidence
- validation claims are backed by commands and output
- no work was silently deferred, scoped out, or left unwired

Return exactly:

# Final Critic

## Reviewed SHA / diff hash
[The commit SHA or diff hash you examined; confirm it equals the shipped HEAD.]

## Verdict
APPROVE / NEEDS_REVISION / BLOCKED

## Completion Integrity
[Does the current diff satisfy the issue, the Full-Resolution Contract, and the no-gap checklist?]

## Review Freshness
[Did reviewer approval happen on this exact SHA/hash?]

## Drift Check
[Any mismatch among code, tests, docs, release notes, package metadata, and final summary?]

## Deferred / Scoped-Out / Unwired
[Any work silently deferred, scoped out, or left unwired. State NONE only if truly none.]

## Evidence Integrity
[Any unbacked validation or correctness claim?]

## Required Revisions
- [Required change or NONE]
```

### Fallback Invocation

If no independent critic is available, write `09-final-critic.md` with the same headings (including `## Reviewed SHA / diff hash` and `## Deferred / Scoped-Out / Unwired`) in one clean adversarial pass, prefixed with "Fallback final critic: independent critic unavailable." Do not leave a stub artifact containing only the disclosure.

### Verdict Semantics

- `APPROVE`: no blocker remains; closure may proceed if no later edit happens.
- `NEEDS_REVISION`: one or more code, docs, tests, or evidence changes are required before closure.
- `BLOCKED`: the completion claim depends on missing context or an unresolved decision.

Any edit after final critic approval invalidates the approval. Re-run implementation review when the edit changes the diff, then re-run the final critic. **Loop bound:** after three reviewer/critic revision cycles without convergence, stop and escalate to the user with both positions and evidence.
