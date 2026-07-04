---
name: tech-debt-ci-review
description: Deep technical debt and CI stability audit for identifying test theater, missing or mis-scoped tests, actual and potential test failures, flaky-test risk, dependency/toolchain brittleness, and structural debt that prevents PRs from going green safely.
disable-model-invocation: true
---

# /tech-debt-ci-review

Run a deep technical debt and CI stability audit of the current repository.

## Mission

Identify every meaningful source of:
- technical debt with real CI impact
- test theater
- missing or mis-scoped tests
- actual and potential test failures
- CI instability
- flaky-test risk
- dependency/build/toolchain brittleness
- verification gaps that prevent the repository from reaching and staying green in pull requests

Do not build features.
Do not do opportunistic cleanup for its own sake.
Do not preserve noisy tests or workflows just because they make dashboards look busy.

## Operating stance

- Treat green-looking CI, high coverage, test names, comments, docs, release notes, and examples as claims or hints, not proof.
- Treat code and tests as plausible until verified, not correct until disproven.
- No finding is valid without exact file path and line evidence, or exact workflow/job/command evidence for CI-level issues.
- No approval-like conclusion is valid without positive evidence of what was checked.
- If a finding depends on runtime behavior, framework behavior, timing, sequencing, state, or exploitability, do not over-claim from static code alone if safe validation is available.

## Quality-over-speed directive

Confidence in the test and CI signal is the main success metric.
There is no time pressure.
There is no reward for finishing in fewer passes.
Do not batch more aggressively, skip validation, or stop early because the repository is large or the audit feels expensive.
Large codebases require more disciplined verification, not less.

## Required workflow

### Phase 0 — Inventory first
In this repository, start from the authoritative contracts: `AGENTS.md`
(especially invariant 6 — never validate the whole repo through broad
`test_runner` scopes; use the per-file isolation loops from `TESTING.md` and
`contributing.md`) and `.github/workflows/ci.yml` for what CI actually
enforces.

Read enough of the repo to build a quality and CI map:
- dependency manifests and lockfiles
- CI workflows and job configs first
- top-level README/docs
- existing QA reports, CI handoffs, or known-failure notes if present
- test runner configuration
- any task brief / PR text / diff context if relevant

Build a map of:
- tech stack
- CI surface
- test surface
- quality surface
- debt surface
- public/risky surfaces

### Phase 1 — Parallel exploration
Use subagents for breadth so the main context stays clean.
Split the repo into disjoint scopes and/or audit families.
Prefer small, focused scopes over giant repo-wide sweeps.

Recommended exploration lanes:
- CI workflow and job graph correctness
- test theater and falsifiability
- flaky-test risk and nondeterminism
- required-vs-optional test necessity
- debt hotspots and maintainability drag
- dependency/build/toolchain brittleness
- behavioral regression exposure in risky modules

Explorer-style subagents should:
- read every file in their assigned scope
- stay focused on one scope or issue family
- return candidate findings only, not final truth
- cite exact paths and lines
- call out where deeper validation is needed

### Phase 2 — Candidate validation in a fresh reviewer context
Treat exploration output as a hypothesis engine, not a final verdict.
Use one or more fresh reviewer contexts to validate candidate findings.

For each candidate finding, classify exactly one:
- CONFIRMED
- DISPROVED
- UNVERIFIED
- PRE_EXISTING

Reviewer must:
1. Re-open the exact files and lines referenced by the explorer
2. Read enough surrounding context to judge correctly
3. Check callers, callees, tests, config, CI jobs, manifests, scripts, docs, and runtime assumptions as needed
4. Check whether a mitigating control invalidates the candidate
5. Run the smallest safe validation loop available when the claim depends on runtime behavior, timing, sequencing, or environment state
6. Reclassify severity if the explorer overclaimed it
7. Record the reason for disproof when rejecting a candidate

If the issue cannot be proven due to ambiguity or missing context, mark it UNVERIFIED, not DISPROVED.

### Phase 3 — Audit checklist
Apply this checklist across the repo:

1. Actual CI failure risk
- broken workflow YAML or invalid job wiring
- incorrect needs/dependency graph
- CI commands that do not match real repo tooling
- matrix values or OS assumptions likely to fail
- caches restoring incompatible artifacts
- missing setup/bootstrap steps
- local-only assumptions in CI
- required checks whose producer/consumer contracts have drifted

2. Test theater
- tests asserting only existence, truthiness, or snapshots with no behavioral meaning
- tests that would pass if the implementation were removed
- tests validating mocks instead of behavior
- edge-case-named tests that only exercise happy path
- coverage theater that ignores critical paths

3. Need for tests
- changed behavior with no regression tests
- public API/schema changes with no protective tests
- critical paths lacking focused tests
- expensive edge cases not covered
- places where tests are unnecessary or low ROI
- opportunities to replace brittle E2E with cheaper lower-level tests

4. Actual and potential test failures
- currently failing tests
- tests likely to fail in CI despite passing locally
- environment-sensitive, order-sensitive, timing-sensitive, or race-prone tests
- hidden shared state between tests
- improper cleanup/teardown
- dependence on wall clock, timezone, locale, random seeds, network, filesystem, temp paths, or machine performance
- brittle selectors or snapshot churn
- hidden credential or unavailable service assumptions

5. Flaky-test risk
- intermittent assertions
- retries masking failures instead of fixing them
- sleeps, polling hacks, fixed delays
- nondeterministic data generation without seeding
- parallel execution hazards
- flaky fixture setup or external dependency reliance
- quarantine/retry practices that keep CI green while hiding root causes

6. Mutation-minded test quality
Use mutation thinking even if no mutation tool exists.
For important tests, ask:
- would this fail if the function returned early?
- would it fail if a boolean were inverted?
- would it fail if an error path were swallowed?
- would it fail if a result were hardcoded?
- would it fail if the dependency call were skipped?
If not, the test is likely theater or too weak.

7. Technical debt with CI impact
- duplicated logic increasing bug-fix surface area
- high-complexity modules hard to test safely
- hidden coupling across modules or fixtures
- stale abstractions and wrappers with no value
- outdated or partially migrated tooling
- dead code or dead tests raising maintenance cost
- brittle build/bootstrap flows
- lack of ownership signals for flaky tests or red suites

8. Dependency, build, and toolchain brittleness
- phantom or suspicious dependencies
- undeclared runtime tools
- local and CI install/build drift
- lockfile or version drift
- cross-platform dependency issues
- build scripts relying on hidden global tools
- optional tools treated as required without guardrails

9. Intended-vs-actual verification for CI and testing
For every important workflow claim, verify whether the repo actually does what it claims, for example:
- PRs are green by default
- tests catch regressions
- lint/typecheck/build are enforced
- reviewers can trust CI
- this suite protects behavior X

### Phase 4 — Runtime-aware validation
Use runtime validation selectively, not blindly.
If a candidate depends on actual behavior, timing, workflow sequencing, role/state transitions, or environment interaction, use the smallest safe validation loop available.
Do not use retries as proof of correctness.
Retries can help separate flaky from deterministic failures, but they are not a fix.

### Phase 5 — Final output
Write the final report to `.claude/reports/tech-debt-report.md` (create the
directory if needed). Do not write it to the repository root, and do not
commit it unless the user asks — it is working output, not a deliverable.

Use this structure:

# Technical Debt and CI Stability Report
Generated: [timestamp]
Scope: [scopes and artifacts covered]
Files reviewed: [count]
Parallel exploration used: YES | NO
Independent reviewer validation used: YES | NO
Runtime validation used: YES | NO

## Executive Summary
[2-4 sentences]

## Current PR/CI Blockers
[only issues actively breaking or very likely to break PR CI]

## Critical and High Findings
[full detail for CONFIRMED and PRE_EXISTING only]

## Test Theater Findings
[tests that create confidence without protection]

## Missing or Mis-Scoped Tests
[where tests are needed, where they are not needed, and where the testing pyramid is wrong]

## Flaky-Test Risks
[confirmed or likely nondeterminism sources]

## Structural Debt with CI Impact
[coupling, brittle setup, outdated tooling, duplicated logic, etc.]

## Dependency and Toolchain Risks
[build/install/runtime brittleness]

## Coverage Notes
[what remained unverified and why]

## Validation Notes
- candidate findings generated: N
- reviewer confirmed: N
- reviewer disproved: N
- reviewer unverified: N
- reviewer pre_existing: N

## Green-PR Remediation Order
1. current red-build blockers
2. flaky tests and nondeterministic CI failures
3. test theater in critical paths
4. missing tests for expensive regressions
5. structural debt directly causing CI and change fragility
6. lower-value cleanup only after the above

When presenting the report, include:
1. the current PR/CI blockers in one-line form
2. the most important test theater patterns
3. the highest-value missing-test gaps
4. the top flaky-test risks
5. the minimal remediation order required to get PR CI trustworthy and green

## Final rules
- No finding without exact evidence.
- No approval-like conclusion without positive evidence of what was checked.
- If a candidate cannot be proven, mark it UNVERIFIED rather than CONFIRMED.
- Do not recommend tests that do not materially improve defect detection.
- Do not preserve test theater just because it makes dashboards look good.
- The point is not to maximize test count or finding count.
- The point is to maximize confidence that PR CI can go green without unsafe bypasses.
