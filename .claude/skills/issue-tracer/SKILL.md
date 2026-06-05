---
name: issue-tracer
description: "Use when asked to trace, investigate, root-cause, plan, fix, close, or prepare a PR for a GitHub issue or bug report. Runs an evidence-first issue workflow: GitHub intake, reproduction, reasoning-guided localization, no-gap fix planning, independent critic review, user approval gate, implementation, tests, and PR-ready closure."
allowed-tools: Read Grep Glob Bash Edit MultiEdit Write WebFetch TodoWrite
---

# Issue Tracer

Use this skill to drive a GitHub issue or bug report from intake to a reviewed closure plan, then, after explicit approval, to a minimal verified fix and PR-ready output.

The default behavior is plan-first. You MUST trace the issue end to end, produce a rock-solid plan, send that plan to an independent critic, incorporate the critic's feedback, present the reviewed plan to the user, and wait for explicit user approval before changing production code.

## Source Policy

Use these sources in this order.

1. GitHub source of truth:
   - If `github_mcp_direct` is available, prefer it for issue fetch, PR metadata, repository metadata, file content, and repository search before falling back to CLI commands.
   - Prefer `gh issue view`, `gh issue list`, `gh pr view`, `gh api`, `git log`, `git blame`, `git diff`, and local repo files.
   - If a GitHub MCP server is available, use it for issue, PR, discussion, and repository metadata.
   - Do not ask the user for GitHub credentials. If GitHub access fails, report the exact blocked operation and fall back to local issue text only.
2. Web source of truth:
   - Use `WebFetch` or equivalent web access for current framework/API behavior, release notes, deprecations, security advisories, and external service semantics.
   - Any plan claim based on external docs must include the URL in the plan.
3. Repository source of truth:
   - Never speculate about code. Open every file before referencing it.
   - Verify every symbol, type, command, test, config entry, and path against the repo.

## Non-Negotiable Rules

1. Quality is the only metric that matters. Time pressure does not exist.
2. Do not implement before the user explicitly approves the reviewed plan.
3. Reproduce or explain non-reproducibility before localizing.
4. Localize before fixing. A plausible patch is not enough.
5. Prefer the smallest patch that fully closes the issue without unwired functionality, untested branches, or hidden regressions.
6. Use parallel reads/searches for independent files and subsystems whenever available.
7. Maintain written artifacts so context compaction or handoff cannot erase the investigation state.
8. If confidence drops below 90%, stop and surface the uncertainty instead of guessing.
9. Do not disable, delete, weaken, or skip tests to make the run green.
10. Do not push, merge, publish, delete data, drop databases, rewrite history, or perform destructive operations without explicit user approval.
11. Evidence-grounded reporting: every claim that a command, build, test, lint, or check "passed" or "was validated" MUST include the exact command and its captured output or exit status. Never assert success you did not observe — show the evidence instead of describing it.
12. Tests passing is "plausible," not "correct." A patch that turns the suite green can still overfit the test and miss the real defect. Before declaring closure you MUST justify, in writing, why the fix is correct against the issue's intended behavior — not merely that tests are green.

## Required Artifacts

Create a trace directory before meaningful investigation:

```text
.claude/issue-traces/<issue-id-or-slug>/
├── 01-issue-summary.md
├── 02-reproduction.md
├── 03-localization-log.md
├── 04-root-cause.md
├── 05-fix-plan.md
├── 06-critic-review.md
├── 07-approved-plan.md
├── 08-test-results.md
├── 08b-implementation-review.md
├── 09-pr-body.md
└── state.md
```

If `.claude/` is not writable or should not be modified in the project, use `tmp/issue-traces/<issue-id-or-slug>/` and say so.

Always update `state.md` at phase boundaries with current phase, completed gates, active hypothesis, selected fix candidate, unresolved risks, and next action.

Detailed templates are in:

- `references/evidence-artifacts.md`
- `references/localization-playbook.md`
- `references/critic-gate.md`
- `assets/pr-template.md`

Read the relevant reference before starting that phase.

## Phase 0: Setup and Scope Control

1. Parse the user request into:
   - issue URL, issue number, or bug description
   - repo path or GitHub owner/repo if provided
   - requested mode: plan-only, plan-then-approval, or approved implementation
2. Check repo state:
   - `git status --short`
   - current branch
   - remotes
   - top-level files such as `CLAUDE.md`, `README*`, package manifests, test configs, CI configs
3. If the worktree has unrelated user changes, do not overwrite them. Continue read-only until you can isolate your changes or ask the user.
4. Create the trace directory and initialize `state.md`.
5. Create a todo list with all phases. Mark only one step in progress at a time, and mark steps complete only after gate verification.

### Phase 0 Gate

Proceed only when:

- repo and issue target are identified or the missing identifier is explicitly documented
- worktree safety is checked
- trace directory exists
- todo list exists
- `state.md` records the starting state

## Phase 1: Intake and Reproduction

Goal: convert the issue into a precise, reproducible engineering problem.

1. Retrieve and read the full issue:
   - `gh issue view <id> --comments --json number,title,body,author,labels,state,comments,createdAt,updatedAt,url`
   - Also read linked PRs, commits, discussions, screenshots, logs, and external docs referenced by the issue.
2. Extract into `01-issue-summary.md`:
   - observed behavior
   - expected behavior
   - exact error messages and stack traces
   - reproduction steps
   - environment, platform, versions, feature flags, config
   - acceptance criteria
   - ambiguity list
3. Identify the project's verification commands by reading actual repo files:
   - `CLAUDE.md`
   - `README*`
   - package manifests
   - Makefiles
   - CI workflow files
   - test configs
4. Attempt reproduction using the smallest faithful command or scenario.
5. Capture exact commands, exit codes, and output in `02-reproduction.md`.
6. If no reproduction exists, create a minimal failing test, script, fixture, or manual reproduction checklist. The reproduction must target the reported behavior, not a guessed implementation detail.

### Phase 1 Gate

Proceed only when one is true:

- the issue is reproduced with exact failing output
- a regression test is written and confirmed failing for the reported behavior
- the issue is not reproducible, and `02-reproduction.md` documents every attempted command, environment mismatch, and missing input needed from the user

If reproduction is impossible because required data, credentials, environment, or hardware is missing, stop and ask for the minimum missing information. Do not jump to a speculative fix.

## Phase 2: Root-Cause Localization

Goal: isolate the root cause to the narrowest truthful granularity: file, symbol, line range, invariant, and triggering input.

Use `references/localization-playbook.md`.

1. Build candidate locations from issue evidence:
   - stack traces and error text
   - failing test names
   - UI route/API endpoint/CLI command names
   - labels and linked PRs
   - recent commits touching related areas
2. Search and read in parallel where possible:
   - `rg` for symbols, routes, commands, strings, errors, config keys
   - `git grep` for tracked-file confirmation
   - `git log --oneline --decorate -- <path>`
   - `git blame -L <start>,<end> -- <path>` where useful
3. Use reasoning-guided hierarchical localization:
   - file-level: which files can plausibly affect the symptom
   - element-level: which functions, classes, handlers, tests, or configs matter
   - line-level: which conditions, calls, assignments, invariants, or boundary checks are wrong
4. Maintain `03-localization-log.md`:
   - every hypothesis
   - files read and why
   - commands run and results
   - evidence for and against each hypothesis
   - ruled-out paths
5. Follow call chains in both directions:
   - from input/event to failure
   - from failure back to origin
   - through config, serialization, async boundaries, state transitions, and feature flags
6. Stop localization only when you can write `04-root-cause.md` in this shape:

```markdown
# Root Cause

## Summary
[One paragraph: what failed, where, and why.]

## Exact Location
- File: `path/to/file.ext`
- Symbol: `functionOrClassName`
- Lines: `start-end`

## Broken Contract
[The invariant/assumption/contract that was violated.]

## Triggering Conditions
[Inputs, environment, state, flags, or sequence required.]

## Evidence Chain
1. [Issue symptom or failing test]
2. [Code path evidence]
3. [Focused command/test evidence]
4. [Why alternatives were ruled out]
```

### Reasoning-guided ranking and confirmation

State-of-the-art agentic fault localization ranks candidates by explicit reasoning, not surface similarity, and confirms high-risk faults with an independent pass:

1. For each surviving candidate location, write a one-paragraph **bug-specific explanation**: precisely why this exact symbol/line could produce the observed symptom under the triggering conditions. "This file looks related" is not a ranking — a candidate with no causal explanation is ranked last or dropped.
2. Rank candidates by causal explanation strength plus direct code evidence (stack-trace/test-spectrum agreement, data-flow reachability, recent diffs), localizing hierarchically: file -> element (function/class/handler/config) -> exact line/condition.
3. Do not propose any patch until the fault is justified at the **line/condition** level, not merely the file level.
4. When the fault is high-risk (security, isolation, IPC, auth, data integrity, concurrency) or the top two candidates are close, run a **second, independent localization pass** that does not read the first pass's conclusion, then reconcile. Agreement across independent passes raises confidence; disagreement means keep localizing rather than guessing.

### Phase 2 Gate

Proceed only when:

- at least two plausible hypotheses were considered or the stack trace/repro uniquely identifies the fault
- the selected root cause has direct code evidence
- every referenced symbol/path was opened and verified
- the triggering condition is known
- each retained candidate has a written bug-specific explanation, and the chosen root cause is localized to the line/condition level
- alternative explanations are ruled out or explicitly documented as residual risk

If two or more hypotheses remain equally plausible, stop and ask for the smallest additional evidence needed.

## Phase 3: Fix Plan and Independent Critic Gate

Goal: produce a no-gap plan, independently review it, revise it, and ask the user for approval before implementation.

Use `references/critic-gate.md`.

1. Generate 3-5 fix candidates when realistic. For trivial single-line defects, include at least the chosen fix and one rejected alternative.
2. Rank candidates by:
   - correctness against root cause
   - minimality
   - regression risk
   - public API compatibility
   - architectural fit
   - testability
   - rollback simplicity
3. Perform impact analysis:
   - callers/importers of changed symbols
   - affected tests and fixtures
   - config and docs surfaces
   - UI/API/CLI contracts
   - persistence/migration implications
   - concurrency, async, idempotency, and retry behavior
   - security and privacy implications
4. Write `05-fix-plan.md` with:
   - issue summary
   - root cause
   - candidates considered and ranking
   - selected fix
   - exact files expected to change
   - functions/classes expected to change
   - edge cases
   - test plan
   - rollout/risk/rollback
   - explicit "unwired functionality" checklist
5. Send the plan to an independent critic:
   - If running in the main session and the `Agent` tool is available, launch a separate critic subagent with `references/critic-gate.md` and the trace artifacts as context.
   - If running as a subagent through `.claude/agents/issue-tracer.md`, do not attempt nested subagent invocation. Claude Code subagents cannot spawn other subagents. Run the full fallback self-critic pass from `references/critic-gate.md` and disclose this to the user.
   - If no independent subagent is available in the current environment, run the fallback adversarial critic pass and clearly label it "Fallback self-critic: independent critic unavailable."
6. The critic must return one of:
   - `APPROVE`
   - `NEEDS_REVISION`
   - `BLOCKED`
7. Revise `05-fix-plan.md` until all critic blockers are resolved or explicitly escalated.
8. Copy the final reviewed plan to `07-approved-plan.md` with an unchecked approval line.
9. Present the final reviewed plan to the user and stop. Ask for explicit approval to implement.

#### High-risk: candidate-patch sampling

For high-risk or close-call fixes, do not commit to a single patch shape prematurely. Draft 2-3 concrete candidate patches for the selected root cause, and choose between them by which one makes the reproduction test pass while keeping the regression suite green and the diff minimal. On a genuine tie, prefer the smallest, most contract-preserving patch and record why the alternatives were rejected. This mirrors validate-then-select repair: a patch is chosen on evidence (tests + minimality), not on first-draft intuition.

### Phase 3 Gate

Do not write production code until:

- `05-fix-plan.md` exists
- `06-critic-review.md` exists
- all critic blockers are resolved or disclosed
- `07-approved-plan.md` exists
- the user explicitly approves implementation

## Phase 4: Implementation After Approval

Goal: implement the smallest complete patch that matches the approved plan.

Begin only after explicit user approval.

1. Re-check `git status --short`.
2. Create or confirm an isolated branch unless the user asked otherwise:
   - `git switch -c fix/<issue-id>-<short-slug>` or equivalent
3. Write or update the failing regression test first.
4. Run the regression test and confirm it fails for the expected reason.
5. Apply the minimal fix.
6. Re-read every changed file.
7. Run the regression test and confirm it passes.
8. Run impacted tests based on the dependency graph and changed files.
9. Run project quality checks discovered in Phase 1:
   - test suite or impacted suite
   - lint
   - typecheck
   - formatting check
   - build
   - security/static checks if the repo already has them
10. Record commands and results in `08-test-results.md`.
11. If any test fails unexpectedly, treat it as signal. Re-enter localization for that failure before changing code again.

### Phase 4 Gate

Proceed only when:

- implementation matches the approved plan or deviations are documented and approved
- regression protection exists
- impacted tests pass, with the exact commands and captured output recorded in `08-test-results.md` (no asserted-but-unshown results)
- required quality checks pass or failures are documented as unrelated with clean-`origin/main` evidence
- a written correctness justification explains why the patch fixes the root cause and does not merely satisfy the test (plausible != correct)
- no TODO, stub, placeholder, dead branch, or unwired path was introduced

## Phase 4.5: Independent Implementation Review

Goal: have a fresh, independent context try to **refute** the implemented patch before it is presented as done. The context that wrote the patch must not be the only context that approves it.

This is distinct from the Phase 3 plan critic: Phase 3 challenges the *plan*; Phase 4.5 challenges the *actual diff and its validation evidence*.

1. Run the review in an independent context:
   - If subagent delegation is available, launch a separate reviewer subagent with `references/critic-gate.md` (Implementation Review section), given only the diff, `08-test-results.md`, and the trace artifacts — not your own reasoning narrative.
   - If running as a subagent that cannot spawn subagents, or no independent context is available, run the fallback adversarial self-review in a clean pass and label it "Fallback self-review: independent reviewer unavailable."
2. The reviewer's mandate is adversarial: find a concrete input, environment, caller, or sequence for which the patch is wrong, incomplete, overfits the regression test, leaves a runtime path unwired, or regresses a contract. It must verify claims against the actual code and command output, not trust the summary.
3. The reviewer returns `APPROVE`, `NEEDS_REVISION`, or `BLOCKED` and writes `08b-implementation-review.md`.
4. Resolve every `NEEDS_REVISION`/`BLOCKED` item by changing code or evidence, then re-review. Do not downgrade a blocker by rewording it.
5. For high-risk work (security, isolation, IPC, auth, payments, migrations, data integrity), an independent implementation review is mandatory before closure, consistent with `../commit-pr/SKILL.md` Step 9.

### Phase 4.5 Gate

Proceed only when:

- `08b-implementation-review.md` exists with a verdict
- the review ran on the real diff and the captured validation evidence
- every blocker is resolved with a code or evidence change, or explicitly escalated to the user
- if the independent reviewer was unavailable, that limitation is disclosed in the artifact and to the user

## Phase 5: Closure and PR-Ready Output

Goal: leave the issue ready for human review or PR creation.

1. Inspect the final diff:
   - `git diff --stat`
   - `git diff`
   - `git diff --check`
2. Verify no unrelated files changed.
3. Write `09-pr-body.md` as a draft using `assets/pr-template.md`.
4. Prepare a conventional commit message:
   - `fix(<scope>): <short issue-specific description>`
5. Publication is governed by the single source of truth, `../commit-pr/SKILL.md`. When the user asks you to commit, push, or open/update a PR — and only after confirming there are no unrelated changes — switch to that skill and follow it for the PR title, the PR body contract (`Closes #<issue>`, `## Summary`, `## Invariant audit`, `## Test plan`), the release fragment, the invariant audit, the issue comment, and CI closeout. `assets/pr-template.md` is a drafting aid; the published PR body must satisfy the `commit-pr` contract (the `pr-standards` check enforces it). Do not invent a parallel PR format.
6. Final response must include:
   - root cause with file/line references
   - exact change summary
   - tests and checks run with results
   - regression coverage
   - unresolved risks, if any
   - PR body or PR link if created

## Test Validation and Drift Review

This section applies to every phase.

Whenever any of the following change, actively review tests for drift:

- command selection logic or framework detection
- fixture expectations or test helper behavior
- workflow assertions or pipeline step ordering
- scanner coverage behavior or tool registration
- prompt content that affects agent behavior
- documentation or comments claiming system behavior

Requirements:

1. Touched tests must be verified against current and intended behavior.
2. Stale tests must be realigned to verified behavior, not left as drift.
3. Prefer behavior-level validation over brittle string-only expectations.
4. New behavior needs positive and negative cases.
5. Boundary-critical or security-sensitive behavior needs adversarial cases.
6. The release verification sweep must include a focused test-drift regression check.
7. Do not accept work where tests pass by coincidence rather than correctness.

## No-Gap Closure Checklist

Before declaring the issue ready:

- [ ] The reported symptom is reproduced or non-reproducibility is proven.
- [ ] The root cause is localized to exact code and triggering conditions.
- [ ] The fix addresses the root cause, not only the visible symptom.
- [ ] Every changed path is wired into the actual runtime path.
- [ ] Public API, CLI, UI, persistence, config, and docs surfaces are checked where relevant.
- [ ] Edge cases are tested or explicitly ruled out.
- [ ] Regression test fails before the fix and passes after the fix when feasible.
- [ ] Impacted tests, lint/type/build checks are run, with commands and captured output recorded.
- [ ] Independent critic review of the plan completed before user approval.
- [ ] User approval obtained before implementation.
- [ ] Independent implementation review (Phase 4.5) completed on the real diff and evidence; blockers resolved.
- [ ] A written correctness justification distinguishes "tests green" from "root cause fixed."
- [ ] Every "passed"/"validated" claim cites the exact command and its captured output.
- [ ] Publication (commit/push/PR) followed `../commit-pr/SKILL.md` (the single source of truth).
- [ ] PR-ready summary is complete.

## Escalation Triggers

Stop and ask the user or present options when:

- reproduction requires unavailable credentials, secrets, data, hardware, or external services
- the issue is actually a feature request or product decision
- a fix requires breaking public API compatibility
- a data migration or destructive operation is required
- root cause spans multiple subsystems and the approved scope is too narrow
- the critic returns `BLOCKED`
- confidence remains below 90% after reasonable investigation

## Method Provenance (state of the art)

The quality methods in this skill are grounded in current agentic-repair and agent-reliability research, adapted to a plan-first, evidence-first workflow:

- Hierarchical file -> function -> line localization, multi-sample candidate patches, and validate-then-select repair: Agentless (Xia et al. 2024, https://arxiv.org/abs/2407.01489).
- Reasoning-guided, explanation-ranked fault localization (causal explanation per candidate, not surface similarity): RGFL (https://arxiv.org/pdf/2601.18044); structure/spectrum-aware search: AutoCodeRover (https://arxiv.org/abs/2404.05427).
- "Tests passing is plausible, not correct" / patch overfitting: patch-correctness survey (https://dl.acm.org/doi/10.1145/3702972).
- Self-consistency across independent passes: Wang et al. 2022 (https://arxiv.org/abs/2203.11171).
- Fresh independent context refutes the result (the doer is not the grader) and evidence-grounded reporting (show the command and its output, do not assert success): Anthropic, "Effective harnesses for long-running agents" (https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).
- Plan -> implement -> review separation as explicit quality gates: Anthropic, "Building Effective Agents" (https://www.anthropic.com/research/building-effective-agents).
- Escalate when the issue lacks reproducible steps or acceptance criteria (issue clarity predicts resolution success): GitHub coding-agent best practices (https://docs.github.com/copilot/how-tos/agents/copilot-coding-agent/best-practices-for-using-copilot-to-work-on-tasks).
