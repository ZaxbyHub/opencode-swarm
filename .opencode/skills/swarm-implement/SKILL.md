---
name: swarm-implement
audience: swarm-plugin
description: Execute complex implementation work with a swarm-like workflow: parallel exploration, scoped planning, objective validation, mandatory independent implementation review for changed work, and final critic approval. Use for feature work, bug fixes, refactors, and multi-file changes.
disable-model-invocation: true
---

# /swarm-implement

Use this skill for implementation work when you want a fast, high-quality swarm
workflow rather than a single-threaded assistant.

## Purpose

Complete real coding tasks while preserving speed and adding swarm-style quality
discipline.

## Core operating model

Use this execution ladder:

1. Explore in parallel.
2. Build a scoped plan.
3. Implement in small, coherent units.
4. Run objective validation.
5. For any worktree edit, use independent reviewer validation on the latest diff
   and evidence.
6. For any worktree edit, use a separate final critic after reviewer approval.
7. Synthesize and report what changed, what was verified, and what remains risky.

## Command Namespace

Swarm commands always use `/swarm <subcommand>`. Never invoke bare subcommand
names that collide with host commands such as `/plan`, `/reset`, `/checkpoint`,
or `/status`.

## High-risk work

Always use the deeper validation path for auth, permissions, payments,
destructive actions, dependency changes, public APIs, schemas, migrations,
concurrency, queues, retries, state machines, caching, file access, subprocesses,
parsing, secrets, security-sensitive logic, and large cross-file refactors with
correctness risk.

## Recommended workflow

### Phase 0 - Establish scope

Determine the exact task scope first:

- what changed or needs to change,
- what files are likely involved,
- what success looks like,
- what must not be broken,
- what verification is required.

If the task is unclear, ask targeted questions or create a short written plan
before coding.

### Phase 0a - Parallel work check

Load and follow
`file:.swarm/bundled-skills/parallel-work-check/SKILL.md`. Then, before
starting implementation on an existing branch:

1. Fetch remote state and compare with local (`git fetch` plus HEAD hashes).
2. If parallel swarm work is detected on the target branch, read the new commits,
   decide whether to integrate, supersede, or proceed, and document the decision.
3. Prefer the parallel work unless you can clearly articulate why your approach
   is better.

### Phase 0b - PR branch checkout pre-flight

When implementation or review-scoping work depends on explorer agents reading a
PR branch or commit range, complete this before Phase 1 explorer dispatch:

1. Verify the working tree is clean with `git status --porcelain`. If
   uncommitted changes exist, stash them or abort the checkout to prevent data
   loss.
2. Fetch and check out the PR head branch locally. Explorer agents read files
   from the working tree (`Read`/`Glob`/`Grep`), not from git history, so a stale
   checkout makes them inspect the base branch.
3. Pass the exact commit range (`base_ref..head_ref`) in every explorer
   delegation so agents have revision context for targeted `git show`
   inspection.

### Phase 1 - Parallel exploration

Launch parallel subagents for disjoint investigation tasks such as repository
mapping, locating existing patterns, finding tests/contracts, side-effect
analysis, and dependency or migration checks. Keep the main context focused.

### Phase 2 - Plan

Create a concrete implementation plan before editing for any non-trivial task.
Include files to change, intended behavior, risks, validation commands, and
whether reviewer and critic passes are required.

### Phase 3 - Implement in scoped units

Implement in coherent, reviewable chunks. Follow existing repository patterns.

**`declare_scope` discipline.** Before every coder or test-engineer delegation (and before every retry of one), call `declare_scope({ taskId, files })` with the exact file list the delegated agent is allowed to modify — including generated/lockfile paths the change will produce (e.g. `dist/*`, `package-lock.json`, `bun.lock`). Scope is enforced at the Edit/Write/Patch tool layer only — bash-based writes (`sed -i`, `echo >`, `cat > <<HEREDOC`, heredoc-to-file redirects) bypass the check (see issue #520), so do not rely on `declare_scope` to bound shell-redirect writes. If the file list is not 100% obvious from the prompt, declare the containing directories instead. Repeat the declaration before every retry, even when files appear unchanged — scope state is per-attempt, not per-task.

If the project exposes `sast_scan` with `capture_baseline`, capture the
phase-scoped SAST baseline before first coder delegation so later scans fail only
on new findings rather than pre-existing infrastructure noise.

### Phase 4 - Objective validation

Run the strongest objective checks available for the task: tests, lint,
typecheck, build, targeted repro scripts, and local runtime verification where
relevant. If you cannot verify it, do not claim it is done.

### Phase 5 - Independent reviewer validation

Use an independent reviewer subagent when the task edits code, tests, docs,
package metadata, release notes, or skill files. The reviewer must inspect the
actual current diff and validation evidence after implementation. Any later edit
invalidates approval and requires re-review.

Reviewer responsibilities:

- inspect the implementation with fresh context,
- look for correctness bugs, edge cases, regressions, claim-vs-actual
  mismatches, and test blind spots,
- default to disbelief until evidence supports the change,
- classify issues as `CONFIRMED`, `DISPROVED`, `UNVERIFIED`, or `PRE_EXISTING`
  when useful,
- verify that at least one regression test in the diff has falsification
  evidence when the task claims regression coverage: the fix was temporarily
  removed or bypassed, the test failed for the expected reason, the fix was
  restored, and the test passed again. If no regression test is applicable, the
  reviewer must record why,
- return `APPROVE`, `NEEDS_REVISION`, or `BLOCKED`.

`NEEDS_REVISION` or `BLOCKED` blocks completion until fixed and re-reviewed.

### Phase 6 - Critic challenge

Use a critic subagent after independent reviewer approval for any task that edits
code, tests, docs, package metadata, release notes, or skill files. The critic
must challenge the reviewer-approved current diff and evidence. Any later edit
invalidates critic approval and requires another critic pass.

### Phase 7 - Final synthesis

Before calling work complete, verify:

- objective validation ran and results were recorded,
- the independent reviewer approved the latest diff and evidence,
- a separate critic approved after reviewer approval,
- every `NEEDS_REVISION` or `BLOCKED` item was fixed and re-reviewed,
- no edit occurred after the latest reviewer/critic approval,
- no behavior is unwired or deferred without explicit user instruction.

## Adapter notes

Runtime-specific adapter skills in `.claude/skills/swarm-implement/` and
`.agents/skills/swarm-implement/` must stay thin and delegate to this canonical
`.opencode` workflow.
