# Evidence Artifacts

Use these templates when a trace directory is warranted. Default path:

```text
.Codex/issue-traces/<issue-id-or-slug>/
```

## `01-issue-summary.md`

```markdown
# Issue Summary

## Source
- Issue: [URL or user-provided text]
- Repo: [owner/repo or local path]
- Labels: [labels]
- State: [open/closed/unknown]

## Observed Behavior
[What actually happens. Include exact errors and stack traces.]

## Expected Behavior
[What should happen.]

## Reproduction Steps
1. [Step]
2. [Step]
3. [Step]

## Environment
- Runtime:
- OS/platform:
- Browser/device:
- Feature flags/config:
- External services:

## Acceptance Criteria
- [ ] [Measurable behavior]
- [ ] [Measurable behavior]

## Ambiguities
- [Question or missing input]
```

## `02-reproduction.md`

```markdown
# Reproduction Evidence

## Commands Tried

### Attempt 1
- Command:
- Exit code:
- Result: CONFIRMED / NOT REPRODUCED / BLOCKED

```text
[Exact output]
```

## Minimal Reproduction
- Test/script/checklist:
- Why it matches the reported issue:

## Reproduction Verdict
[Confirmed, blocked, or non-reproducible with reason.]
```

## `03-localization-log.md`

```markdown
# Localization Log

## Active Hypotheses

### H1: [Hypothesis]
- Status: active / confirmed / ruled_out / inconclusive
- Suspected file/symbol:
- Evidence for:
- Evidence against:
- Commands/tests:
- Verdict:

## Files Read
- `path/file.ext:lines` - [why read] - [what was learned]

## Searches Run
- `rg "pattern"` - [result]

## Tests/Commands Run
- `command` - PASS/FAIL/BLOCKED - [meaning]

## Ruled-Out Paths
- [Path] - [why ruled out]
```

## `04-root-cause.md`

```markdown
# Root Cause

## Summary
[What failed, where, and why.]

## Exact Location
- File:
- Symbol:
- Lines:

## Broken Contract
[Invariant or behavioral contract violated.]

## Triggering Conditions
[Inputs/state/environment required.]

## Evidence Chain
1. [Symptom]
2. [Code evidence]
3. [Command/test evidence]
4. [Ruled-out alternatives]

## Confidence
[0-100% with reason. Stop below 90%.]
```

## `05-fix-plan.md`

```markdown
# Fix Plan

## Issue
[Short summary.]

## Root Cause
[From 04-root-cause.md.]

## Candidate Fixes
| Candidate | Approach | Files | Pros | Cons | Verdict |
|---|---|---|---|---|---|
| A | [Minimal guard/logic/config/state/API fix] | [files] | [pros] | [cons] | selected/rejected |

## Selected Fix
[Exact behavioral change and why it is necessary and sufficient.]

## Files Expected to Change
- `path/file.ext` - [exact reason]

## Impact Analysis
- Callers/importers:
- Tests/fixtures:
- Config/docs:
- API/UI/CLI:
- Persistence/migrations:
- Security/privacy:
- Concurrency/idempotency:
- opencode-swarm invariants touched:

## Edge Cases
- [edge] - covered by [test/check]

## Test Plan
1. [Failing regression test]
2. [Impacted suite]
3. [Lint/type/build/security checks]

## Unwired Functionality Checklist
- [ ] Entry point reaches new/changed logic.
- [ ] All callers use the updated contract correctly.
- [ ] Error path is observable and handled.
- [ ] No new branch lacks tests or manual verification.
- [ ] Documentation/comments match actual behavior.

## Risk and Rollback
- Risk:
- Rollback:

## Critic Status
- Critic verdict:
- Required revisions:
```

## `06-critic-review.md`

Use `references/critic-gate.md`.

## `07-approved-plan.md`

```markdown
# Reviewed Plan

[Copy final 05-fix-plan.md here.]

## User Approval
- [ ] User explicitly approved implementation on [date/time/session note]
```

In approved-implementation mode, record why approval was already implied by the user's request instead of blocking.

## `08-test-results.md`

```markdown
# Test Results

## Regression Test
- Command:
- Before fix: FAIL / not run with reason
- After fix: PASS / FAIL

## Impacted Tests
- Command:
- Result:

## Quality Checks
- Lint:
- Typecheck:
- Build:
- Format:
- Security/static checks:

## Verification Reasoning
[Why the fix is correct beyond merely making tests pass.]

## Test Drift Review
[Any stale tests found and how they were handled.]

## Invariant Audit Evidence
[For opencode-swarm touched invariants, list concrete command/source evidence.]
```

## `09-pr-body.md`

Use `assets/pr-template.md`.

## `state.md`

```markdown
# Trace State

- Phase:
- Completed gates:
- Active hypothesis:
- Selected fix:
- Unresolved risks:
- Next action:
```
