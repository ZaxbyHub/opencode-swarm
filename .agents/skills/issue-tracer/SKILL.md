---
name: issue-tracer
description: Evidence-first issue and bug investigation for Codex. Use when asked to trace, investigate, root-cause, plan, fix, close, or prepare a PR for a GitHub issue, bug report, regression, failing test, or confusing runtime behavior. Drives intake, reproduction, localization, critic review, implementation, validation, invariant-aware PR closure, and no-gap evidence capture.
---

# Issue Tracer

## Overview

Use this skill to take a GitHub issue or bug report from intake to a verified fix or a reviewed plan. Preserve evidence over polish: reproduce before localizing, localize before fixing, and validate the runtime path before declaring closure.

This is the Codex-native version. Use Codex tools and workflow defaults:

- Use `shell_command` for repository commands, `rg`, `git`, `gh`, tests, builds, and local validation.
- Use `apply_patch` for manual file edits.
- Use `update_plan` for phase tracking on substantial work.
- Use the GitHub app or `gh` for issue and PR metadata when available.
- Use `web` only for current external framework/API behavior, advisories, or release notes; cite URLs for external claims.
- Use parallel reads/searches when independent files or subsystems can be inspected safely.

## Mode Selection

Infer the mode from the user request and newest instructions.

- `plan-only`: trace, reproduce/localize where possible, run critic review, and stop with a reviewed plan.
- `plan-then-approval`: produce a reviewed plan and wait for explicit approval before production-code edits.
- `approved implementation`: if the user already asked to fix or implement, continue through reproduction, localization, minimal patch, validation, and PR-ready summary.
- `high-risk`: require approval before edits when the fix is destructive, broad, breaking, migration-heavy, or depends on unavailable secrets/data.

Do not force a blocking approval gate for ordinary Codex implementation work when the user already asked for the fix. Do force it for plan-only requests, high-risk work, destructive operations, or explicit user instructions.

## Repo Contract

For `opencode-swarm`, read the repo contract before meaningful work:

1. `AGENTS.md`
2. `docs/engineering-invariants.md` when touching relevant invariants
3. `.opencode/skills/writing-tests/SKILL.md` before writing or modifying tests
4. `.opencode/skills/engineering-conventions/SKILL.md` before architecture, plugin init, subprocess, tool registration, plan durability, `.swarm` storage, runtime portability, session/global state, guardrails/retry, chat/system hook, or release/cache work
5. `.claude/skills/commit-pr/SKILL.md` before commit, push, or PR creation unless a Codex publish skill supersedes it

If `.Codex/session/swarm-mode.md` exists, read it before complex work and follow its quality gates.

Every PR for this repo must include an invariant audit for touched areas. Evidence must be concrete: commands, test output, source inspection, or grep results.

## Trace Artifacts

For deep issue tracing, create a resumable trace directory:

```text
.Codex/issue-traces/<issue-id-or-slug>/
|-- 01-issue-summary.md
|-- 02-reproduction.md
|-- 03-localization-log.md
|-- 04-root-cause.md
|-- 05-fix-plan.md
|-- 06-critic-review.md
|-- 07-approved-plan.md
|-- 08-test-results.md
|-- 09-pr-body.md
`-- state.md
```

For small fixes, a compact in-thread evidence trail is acceptable unless the user requests trace artifacts, context may be long-running, or the issue is ambiguous/high-risk. When artifacts are used, update `state.md` at phase boundaries with phase, completed gates, active hypothesis, selected fix, risks, and next action.

Read the phase reference before using it:

- `references/evidence-artifacts.md` for artifact templates
- `references/localization-playbook.md` for root-cause localization
- `references/critic-gate.md` for independent or fallback critic review
- `assets/pr-template.md` for PR-ready closure text

## Phase 0: Setup

1. Parse the issue URL, number, PR link, failing command, or bug description.
2. Identify repo root, branch, remotes, and worktree safety with `git status --short`.
3. Inspect project instructions, manifests, test configs, CI configs, and relevant local skills.
4. Create trace artifacts when warranted.
5. Start or update an `update_plan` checklist for substantial work.

Gate: proceed only when the target, repo state, and applicable instructions are known or the missing inputs are documented.

## Phase 1: Intake and Reproduction

1. Fetch issue metadata with the GitHub app or:

```powershell
gh issue view <id> --comments --json number,title,body,author,labels,state,comments,createdAt,updatedAt,url
```

2. Read linked PRs, commits, logs, screenshots, discussions, and external docs referenced by the issue.
3. Extract observed behavior, expected behavior, exact errors, reproduction steps, environment, acceptance criteria, and ambiguities.
4. Discover verification commands from actual repo files, not memory.
5. Reproduce with the smallest faithful command or scenario.
6. If direct reproduction is impossible, create or describe a minimal failing test/script/checklist that targets the reported behavior.

Gate: continue only when the issue is reproduced, a faithful failing regression exists, or non-reproducibility is documented with missing inputs.

## Phase 2: Localization

Use `references/localization-playbook.md`.

1. Build candidate locations from traces, failing tests, UI/API/CLI names, labels, linked PRs, and recent commits.
2. Search with `rg` and read every referenced file before making claims.
3. Follow call chains from entry point to failure and backward from failure to origin.
4. Track hypotheses, evidence for/against, ruled-out paths, and files read.
5. Stop only when root cause is localized to file, symbol, line range or function, broken contract, and triggering conditions.

Gate: at least two plausible hypotheses are considered unless the trace uniquely identifies the fault; selected root cause has direct code and command/test evidence.

## Phase 3: Plan and Critic Review

Use `references/critic-gate.md`.

1. Generate candidate fixes when realistic; for trivial defects include the selected fix and at least one rejected alternative.
2. Rank by correctness, minimality, regression risk, API compatibility, architectural fit, testability, and rollback simplicity.
3. Analyze callers/importers, config, docs, UI/API/CLI paths, persistence, concurrency, retry, cancellation, security, and privacy where relevant.
4. Write a fix plan with exact files, functions, test plan, unwired-functionality checklist, risks, and rollback.
5. Run an independent critic only when a separate subagent/delegation mechanism is available and the user/session has authorized it.
6. If no independent critic is available, run the full fallback self-critic and label it exactly: `Fallback self-critic: independent critic unavailable.`
7. Revise until critic blockers are resolved or explicitly escalated.

Gate: implementation may begin only when mode permits it and critic blockers are resolved. In `plan-only` or `plan-then-approval`, stop for user approval.

## Phase 4: Implementation

1. Re-check `git status --short`.
2. Protect unrelated user changes. Do not revert or overwrite them.
3. Write/update the failing regression first when feasible, and confirm it fails for the expected reason.
4. Apply the minimal fix with `apply_patch`.
5. Re-read changed files and verify all runtime entry points are wired.
6. Run focused regression tests, impacted tests, and repo-required checks. For `opencode-swarm`, use shell commands for repo validation; do not use broad OpenCode `test_runner` scopes.
7. Record commands, exit codes, and meaningful output.

Gate: changed behavior matches the reviewed plan or the deviation is documented; regression protection exists or infeasibility is justified; impacted checks pass or unrelated failures are proven.

## Phase 5: Closure

1. Inspect `git diff --stat`, `git diff`, and `git diff --check`.
2. Verify no unrelated files changed.
3. Prepare PR text with `assets/pr-template.md`.
4. Include root cause with file/line references, change summary, tests/checks, regression coverage, invariant audit evidence for touched areas, and residual risks.
5. Commit, push, or open a PR only when the user explicitly asked and the repo publish instructions have been loaded.

## No-Gap Checklist

- Reported symptom is reproduced or non-reproducibility is proven.
- Root cause is localized to exact code and triggering conditions.
- Fix addresses the root cause, not only the visible symptom.
- Every changed path is wired into the actual runtime path.
- Public API, CLI, UI, persistence, config, docs, and generated surfaces are checked where relevant.
- Positive, negative, boundary, and adversarial cases are covered or explicitly ruled out.
- Regression test fails before the fix and passes after the fix when feasible.
- Impacted tests and quality checks are run.
- Critic review completed before approval or implementation gate.
- PR-ready summary is complete.
