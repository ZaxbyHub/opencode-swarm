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
- `review-followup`: if the user pastes PR review feedback, treat each finding as a claim to verify against the current branch or live PR head before editing. Classify items as confirmed, disproved, pre-existing, or unverified, and patch only the confirmed gaps.

Do not force a blocking approval gate for ordinary Codex implementation work when the user already asked for the fix. Do force it for plan-only requests, high-risk work, destructive operations, or explicit user instructions.

## Repo Contract

For `opencode-swarm`, read the repo contract before meaningful work:

1. `AGENTS.md`
2. `docs/engineering-invariants.md` when touching relevant invariants
3. `.opencode/skills/writing-tests/SKILL.md` before writing or modifying tests
4. `.opencode/skills/engineering-conventions/SKILL.md` before architecture, plugin init, subprocess, tool registration, plan durability, `.swarm` storage, runtime portability, session/global state, guardrails/retry, chat/system hook, or release/cache work
5. `.agents/skills/commit-pr/SKILL.md` before commit, push, or PR creation; use `.claude/skills/commit-pr/SKILL.md` as the underlying repo protocol it points to

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
|-- 08b-implementation-review.md
|-- 09-final-critic.md
|-- 10-pr-body.md
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
3. If the input includes PR review feedback, refresh the live PR head or active branch before trusting any pasted claim.
4. Extract observed behavior, expected behavior, exact errors, reproduction steps, environment, acceptance criteria, and ambiguities.
5. Discover verification commands from actual repo files, not memory.
6. Reproduce with the smallest faithful command or scenario.
7. If direct reproduction is impossible, create or describe a minimal failing test/script/checklist that targets the reported behavior.

Gate: continue only when the issue is reproduced, a faithful failing regression exists, or non-reproducibility is documented with missing inputs.

## Phase 2: Localization

Use `references/localization-playbook.md`.

1. Build candidate locations from traces, failing tests, UI/API/CLI names, labels, linked PRs, and recent commits.
2. Search with `rg` and read every referenced file before making claims.
3. Follow call chains from entry point to failure and backward from failure to origin.
4. Track hypotheses, evidence for/against, ruled-out paths, and files read.
5. For each surviving candidate, write a one-paragraph bug-specific explanation of why that exact symbol/line could produce the symptom under the triggering conditions, and rank candidates by causal explanation strength plus direct evidence (trace/test agreement, data-flow reachability, recent diffs). Surface similarity ("this file looks related") is not a ranking.
6. Stop only when root cause is localized to file, symbol, and line/condition, with broken contract and triggering conditions; do not propose a patch until the fault is justified at the line/condition level.
7. For high-risk faults (security, isolation, IPC, auth, data integrity, concurrency) or when the top two candidates are close, run a second independent localization pass that does not read the first pass's conclusion, then reconcile before choosing.

Gate: at least two plausible hypotheses are considered unless the trace uniquely identifies the fault; each retained candidate has a written bug-specific explanation; selected root cause is localized to the line/condition level with direct code and command/test evidence.

## Phase 3: Plan and Critic Review

Use `references/critic-gate.md`.

1. Generate candidate fixes when realistic; for trivial defects include the selected fix and at least one rejected alternative.
2. Rank by correctness, minimality, regression risk, API compatibility, architectural fit, testability, and rollback simplicity.
3. Analyze callers/importers, config, docs, UI/API/CLI paths, persistence, concurrency, retry, cancellation, security, and privacy where relevant.
4. Write a fix plan with exact files, functions, test plan, unwired-functionality checklist, risks, and rollback.
5. Run an independent critic only when a separate subagent/delegation mechanism is available and the user/session has authorized it.
6. If no independent critic is available, run the full fallback self-critic and label it exactly: `Fallback self-critic: independent critic unavailable.`
7. Revise until critic blockers are resolved or explicitly escalated.
8. High-risk or close-call fixes: draft 2-3 concrete candidate patches and choose between them by which makes the reproduction test pass while keeping the regression suite green and the diff minimal; on a tie, prefer the smallest contract-preserving patch and record why the alternatives were rejected. Select a patch on evidence, not first-draft intuition.

Gate: implementation may begin only when mode permits it and critic blockers are resolved. In `plan-only` or `plan-then-approval`, stop for user approval.

## Phase 4: Implementation

1. Re-check `git status --short`.
2. Protect unrelated user changes. Do not revert or overwrite them.
3. Write/update the failing regression first when feasible, and confirm it fails for the expected reason.
4. Apply the minimal fix with `apply_patch`.
5. Re-read changed files and verify all runtime entry points are wired.
6. Run focused regression tests, impacted tests, and repo-required checks. For `opencode-swarm`, use shell commands for repo validation; do not use broad OpenCode `test_runner` scopes.
7. When broad local suites are noisy, host-specific, or plausibly pre-existing, compare the failing path against a clean `origin/main` worktree and document the result. Use remote CI as the final cross-platform publish signal when local host behavior is not authoritative.
8. Record commands, exit codes, and meaningful output. Every "passed"/"validated" claim must cite the exact command and its captured output — never assert success you did not observe.

Gate: changed behavior matches the reviewed plan or the deviation is documented; regression protection exists or infeasibility is justified; impacted checks pass with commands and output recorded, or unrelated failures are proven on clean `origin/main`; a written correctness justification explains why the patch fixes the root cause and not merely the test (plausible != correct).

## Phase 4.5: Independent Implementation Review

Have a fresh, independent context try to refute the implemented patch before it is presented as done. This challenges the actual diff and its evidence; it is distinct from the Phase 3 plan critic. The context that wrote the patch must not be the only one that approves it.

1. If a separate subagent/delegation mechanism is available and authorized, run the reviewer with `references/critic-gate.md` (Implementation Review section), given only the diff, `08-test-results.md`, and the trace artifacts.
2. Otherwise run the fallback adversarial self-review in a clean pass and label it: `Fallback self-review: independent reviewer unavailable.`
3. The reviewer's mandate is adversarial: find a concrete input/environment/caller/sequence where the patch is wrong, incomplete, overfits the regression test, leaves a runtime path unwired, or regresses a contract — verifying against real code and captured output, not the implementer's narrative.
4. Record the verdict (`APPROVE`/`NEEDS_REVISION`/`BLOCKED`) and responses in `08b-implementation-review.md`; resolve every blocker with a code or evidence change, then re-review. For high-risk work (security, isolation, IPC, auth, payments, migrations, data integrity), this review is mandatory before closure, consistent with `../commit-pr/SKILL.md` Step 9.
5. If subagent delegation is available and the user/session has authorized issue-tracer or swarm work, independent implementation review is mandatory for any code, test, docs, package metadata, release note, or skill-file edit. Fallback self-review is allowed only when no independent context is available, and that limitation must be disclosed.
6. Any edit after reviewer approval invalidates that approval. Re-run the review on the latest diff and evidence.

Gate: `08b-implementation-review.md` exists with a verdict; the review ran on the real diff and captured evidence; every blocker is resolved or explicitly escalated; reviewer unavailability is disclosed if it occurred; the latest edit happened before the latest reviewer approval.

## Phase 4.6: Final Critic Gate

After implementation review approval, have a separate critic challenge the whole completion claim: current diff, validation evidence, implementation-review artifact, docs/release/package claims, and no-gap checklist.

1. If subagent delegation is available, launch a critic with `references/critic-gate.md` (Final Critic section), giving it the current diff, `08-test-results.md`, `08b-implementation-review.md`, and trace artifacts.
2. If no independent critic is available, run the fallback adversarial critic pass and label it `Fallback final critic: independent critic unavailable.`
3. Write `09-final-critic.md` with verdict `APPROVE`, `NEEDS_REVISION`, or `BLOCKED`.
4. Resolve every `NEEDS_REVISION`/`BLOCKED` item by changing code, docs, tests, or evidence, then re-run implementation review when the fix changes the diff and re-run final critic.
5. Any edit after final critic approval invalidates that approval.

Gate: `09-final-critic.md` exists with verdict `APPROVE`; the critic reviewed the latest diff after implementation reviewer approval; every reviewer/critic blocker is resolved and re-reviewed; no edit occurred after the latest reviewer and critic approvals.

## Phase 5: Closure

1. Inspect `git diff --stat`, `git diff`, and `git diff --check`.
2. Verify no unrelated files changed.
3. Draft PR text with `assets/pr-template.md`.
4. Include root cause with file/line references, change summary, tests/checks, regression coverage, invariant audit evidence for touched areas, and residual risks.
5. If this is review follow-up work, refresh the existing PR body and validation summary when pass counts, caveats, or invariant evidence changed.
6. Publication is governed by the single source of truth, `.claude/skills/commit-pr/SKILL.md` (via the `.agents/skills/commit-pr/SKILL.md` adapter). When the user explicitly asks to commit, push, or open/update a PR, switch to that skill and follow it for the PR title, the PR body contract (`Closes #`, `## Summary`, `## Invariant audit`, `## Test plan`), the release fragment, the invariant audit, the issue comment, and CI closeout. `assets/pr-template.md` is a drafting aid; the published PR must satisfy the `commit-pr` contract, which the `pr-standards` check enforces.

## No-Gap Checklist

- Reported symptom is reproduced or non-reproducibility is proven.
- Root cause is localized to exact code and triggering conditions.
- Fix addresses the root cause, not only the visible symptom.
- Every changed path is wired into the actual runtime path.
- Public API, CLI, UI, persistence, config, docs, and generated surfaces are checked where relevant.
- Positive, negative, boundary, and adversarial cases are covered or explicitly ruled out.
- Regression test fails before the fix and passes after the fix when feasible.
- Impacted tests and quality checks are run.
- Suspected pre-existing or host-specific failures are compared against clean `origin/main` or explicitly documented as unverified.
- Plan critic review completed before approval or implementation gate.
- Independent implementation review (Phase 4.5) completed on the real diff and evidence; blockers resolved.
- Final critic review (Phase 4.6) approved the latest diff and evidence after implementation review.
- No edit occurred after the latest reviewer and critic approvals.
- A written correctness justification distinguishes "tests green" from "root cause fixed."
- Every "passed"/"validated" claim cites the exact command and its captured output.
- Publication (commit/push/PR) followed `.claude/skills/commit-pr/SKILL.md` (the single source of truth).
- PR-ready summary is complete.

## Method Provenance (state of the art)

These methods are grounded in current agentic-repair and agent-reliability research: hierarchical file -> function -> line localization, multi-sample candidate patches, and validate-then-select repair (Agentless, https://arxiv.org/abs/2407.01489); reasoning-guided, explanation-ranked localization (RGFL, https://arxiv.org/pdf/2601.18044; AutoCodeRover, https://arxiv.org/abs/2404.05427); "tests passing is plausible, not correct" / patch overfitting (https://dl.acm.org/doi/10.1145/3702972); self-consistency across independent passes (https://arxiv.org/abs/2203.11171); a fresh independent context refutes the result and evidence-grounded reporting (Anthropic, https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents); plan -> implement -> review separation (Anthropic, https://www.anthropic.com/research/building-effective-agents).
