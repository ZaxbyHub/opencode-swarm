---
name: swarm
description: Enable a high-quality swarm-like Claude Code workflow for the current session, and optionally execute a task immediately using that mode. Uses parallel subagents for breadth, independent reviewer validation for precision, and critic challenge for final confidence. Use when the user wants swarm-like behavior, higher review rigor, or maximum quality without sacrificing Claude Code speed.
disable-model-invocation: true
argument-hint: "[optional task]"
---

# /swarm

Enable swarm mode for the current session.
If arguments are provided, enable swarm mode first and then execute that task using the swarm-like implementation workflow.

Argument handling:
- If no arguments are provided: only enable swarm mode.
- If the first word of `$ARGUMENTS` is a **known plugin subcommand** (see list below): do NOT treat it as a swarm task. Instead, tell the user to run it as a slash command directly (e.g., `/swarm close`, `/swarm handoff`). These are OpenCode plugin commands handled by the swarm plugin's command system, not tasks for the swarm workflow. Do NOT try to interpret or execute them yourself.
- Otherwise: enable swarm mode, then treat `$ARGUMENTS` as the task to execute immediately.

### SWARM-NAMESPACED subcommands — DO NOT confuse with Claude Code built-in commands

These are invoked as `/swarm <subcommand>`, NOT as bare `/subcommand`:

- `/swarm status` — show current swarm status
- `/swarm plan` — view or manage implementation plan
- `/swarm agents` — list available swarm agents
- `/swarm history` — view swarm execution history
- `/swarm config` — view swarm configuration
- `/swarm evidence` — view evidence files
- `/swarm handoff` — hand off to another agent
- `/swarm archive` — archive swarm sessions
- `/swarm diagnose` / `/swarm diagnosis` — diagnose swarm issues
- `/swarm preflight` — run preflight checks
- `/swarm sync-plan` — sync plan with repository
- `/swarm benchmark` — run benchmarks
- `/swarm export` — export swarm data
- `/swarm reset` — reset swarm state
- `/swarm rollback` — rollback to previous state
- `/swarm retrieve` — retrieve swarm data
- `/swarm clarify` — clarify swarm task
- `/swarm analyze` — analyze swarm execution
- `/swarm specify` — specify swarm requirements
- `/swarm brainstorm` — brainstorm swarm tasks
- `/swarm qa-gates` — manage QA gates
- `/swarm dark-matter` — detect hidden couplings
- `/swarm knowledge` — manage knowledge base
- `/swarm curate` — curate knowledge
- `/swarm turbo` — enable turbo mode
- `/swarm full-auto` — enable full auto mode
- `/swarm write-retro` — write retrospective
- `/swarm reset-session` — reset session
- `/swarm simulate` — simulate swarm execution
- `/swarm promote` — promote knowledge
- `/swarm issue` — create issue
- `/swarm pr-review` — review pull request
- `/swarm pr-feedback` — ingest and close known PR feedback (review comments, CI failures, conflicts)
- `/swarm deep-dive` — read-only deep codebase audit (parallel explorers, dual reviewers, critic)
- `/swarm codebase-review` — run codebase-review-swarm
- `/swarm checkpoint` — checkpoint session state
- `/swarm close` — close swarm session

### CRITICAL NAMING CONFLICTS

These swarm subcommands share exact names with CC built-in commands.
Invoking the bare form instead of `/swarm <name>` causes irreversible damage:

| Swarm Command | CC Built-in | Damage |
|---|---|---|
| `/swarm plan` | CC `/plan` | Enters CC plan mode — blocks execution |
| `/swarm reset` | CC `/reset` | Wipes entire conversation context |
| `/swarm checkpoint` | CC `/checkpoint` | Reverts conversation history |

All swarm commands: `/swarm <subcommand>`. Never the bare name.

### COMMAND INVOCATION RULE

All commands in this list are invoked as `/swarm <subcommand>`.
Never invoke the bare subcommand as a standalone slash command.
`/plan`, `/status`, `/reset`, `/checkpoint`, `/agents`, `/config`, `/export`, `/doctor`
are Claude Code built-in commands with completely different behaviors.
The `/swarm` prefix is mandatory, not optional.

Examples:
- `/swarm` — enable swarm mode only
- `/swarm implement OAuth login without breaking existing session handling` — enable swarm mode, then execute the task
- `/swarm fix the failing auth refresh tests and verify the session flow` — enable swarm mode, then execute the task
- `/swarm close` — this is a plugin subcommand; tell the user it will be handled by the plugin command system
- `/swarm handoff` — this is a plugin subcommand; tell the user it will be handled by the plugin command system

## Goal
Turn Claude Code into a swarm-like orchestrator while preserving Claude Code speed advantages.

## What this mode changes
When enabled, Claude should:
- use parallel subagents aggressively for disjoint exploration, codebase mapping, and specialist review
- separate candidate generation from validation
- use independent reviewer and critic contexts that are explicitly skeptical and suspicious
- avoid letting implementation and verification happen in the same context when verification quality would benefit from separation
- keep quality as the only metric that matters
- treat time pressure as nonexistent
- preserve normal Claude Code strengths: parallel subagents, scoped exploration, and fast synthesis
- protect speed by spending the deepest validation effort only where it materially reduces ship risk

## Quality and speed policy
Code quality and pre-ship defect detection are paramount.
Speed still matters.
The point of swarm mode is not to recreate slow serial swarm behavior inside Claude Code.
The point is to keep Claude Code fast by parallelizing everything that can safely be parallelized while preserving a strict validation architecture.

That means:
- parallelize breadth aggressively
- validate in depth selectively based on risk
- avoid running the heaviest critic loop on every low-value issue
- spend the most time on correctness, security, edge cases, regressions, and claimed-vs-actual mismatches
- keep low-risk nits cheap

If a workflow step does not materially improve quality, correctness, or trust, keep it lightweight or skip it.
If a workflow step prevents real bugs from shipping, keep it even if it costs time.

## Default triage model
Use this default escalation ladder for exploration, candidate findings, and read-only work:
1. Parallel exploration and mapping for breadth
2. Parallel specialist review for disjoint concerns
3. Independent reviewer validation for findings that are high-risk, ambiguous, cross-file, or likely false-positive-prone
4. Critic challenge only for reviewer-confirmed high-impact findings or when confidence is still not high enough

Do not use this risk ladder to weaken the mandatory implementation closeout gate below. Any task that edits code, tests, docs, package metadata, release notes, or skill files must still complete the implementation reviewer and final critic gates on the latest diff and evidence.

High-risk work includes:
- auth, authz, permissions, identity, session handling
- payments, billing, data mutation, destructive actions
- dependency changes, install scripts, lockfile changes
- public API changes, schema changes, migrations
- concurrency, retries, state machines, caching, queueing
- security-sensitive parsing, file access, subprocesses, secrets

Lower-risk read-only or answer-only work can use a lighter path if evidence is strong:
- answering a question about existing code or docs
- summarizing an already-reviewed diff without editing it
- reading logs or test output and explaining the likely cause
- checking whether a file or command exists without changing the worktree

## Mandatory implementation closeout gate

For any swarm task that edits code, tests, docs, package metadata, release notes, or skill files, do not declare completion until all of these are true:

1. Objective validation has run and the commands/results are recorded.
2. A fresh independent implementation reviewer has reviewed the actual current diff and validation evidence.
3. A separate critic has challenged the reviewer-approved current diff and evidence.
4. Every `NEEDS_REVISION`, `REJECTED`, or `BLOCKED` reviewer/critic item was fixed with code, docs, or evidence and then re-reviewed.
5. The latest edit is older than the latest reviewer approval and critic approval.
6. Reviewer and critic verdicts are recorded in durable task artifacts. For issue-tracer work, use `08b-implementation-review.md` and `09-final-critic.md`; for other changed-work tasks, create or update task-local review artifacts unless the repo forbids artifacts.

Explorer findings, plan critics, passing tests, and self-review do not satisfy the implementation reviewer gate. If subagent delegation is available and the user/session has authorized swarm work, fallback self-review is not allowed. If no independent context is available, disclose that limitation explicitly and do not imply full swarm validation.

Any edit after reviewer or critic approval invalidates that approval. Re-run the affected reviewer/critic gate before final synthesis.

## Enablement steps
1. Create `.claude/session/` if it does not exist.
2. Create or overwrite `.claude/session/swarm-mode.md` with the exact content below.
3. Confirm that swarm mode is now enabled for this session.
4. For the user's next complex task, follow the swarm-mode contract automatically unless the user disables it.

Write this exact file:

```md
# Swarm Mode Contract

Swarm mode is enabled for this session.

## Core principles
- Quality is the only success metric.
- There is no time pressure.
- There is no reward for finishing in fewer passes.
- Large tasks require more disciplined verification, not less.
- Use parallel subagents whenever scopes are disjoint and doing so does not reduce quality.
- Keep breadth, validation, and final challenge in separate contexts when possible.

## Role model
- Explorer role: fast, broad, cheap, suspicious mapper and candidate generator
- Reviewer role: independent validator of candidate findings, hyper-critical and skeptical
- Critic role: final challenger of reviewer-confirmed findings, hyper-suspicious and willing to overturn weak claims
- Main thread: architect/orchestrator that assigns scopes, persists state, and synthesizes only validated outputs

## Hard rules
- Explorer findings are candidate findings, not final findings.
- Candidate findings should be validated by an independent reviewer context before being treated as confirmed whenever the task is important enough to justify it.
- Reviewer should default to DISPROVED or UNVERIFIED unless the finding is actually supported by code evidence and, when relevant, runtime-aware verification.
- Critic should challenge reviewer-confirmed findings in small batches.
- For any task that edits code, tests, docs, package metadata, release notes, or skill files, final completion requires an independent implementation reviewer approval and a separate critic approval on the latest diff and evidence.
- Passing tests, explorer output, plan critique, and self-review do not satisfy the final implementation reviewer or critic gates when independent subagents are available.
- Any edit after reviewer or critic approval invalidates that approval; re-run the affected gate.
- A `NEEDS_REVISION`, `REJECTED`, or `BLOCKED` verdict blocks final completion until fixed and re-reviewed.
- If quality and speed conflict, quality wins.
- Do not batch more aggressively or skip validation because the repo is large.
- Premature completion is a failure state.

## Parallelism policy
Use parallel subagents for:
- repository mapping
- subsystem investigation
- test analysis
- security review
- performance review
- dependency review
- docs/release drift review
- candidate-finding validation when clusters are disjoint
- changed-area impact analysis
- implementation planning across disjoint modules

Do not parallelize tasks that edit the same files unless the workflow explicitly isolates them.
Parallelism is the default speed lever.
Use it aggressively wherever scopes are disjoint.
Serial work is for synthesis, conflict-prone edits, and final high-confidence validation.

## Default execution pattern for complex tasks
1. Explore and map in parallel.
2. Build a plan.
3. Implement in scoped units.
4. Validate with independent reviewer context.
5. Challenge changed-work completion with a separate critic context.
6. Synthesize only validated results.

## Anti-rationalization rules
Ignore these thoughts:
- "This is probably fine"
- "The broad reviewer is good enough"
- "I can save time by merging validation stages"
- "This repo is too large to review this carefully"
- "I should move on because this is taking too long"

If any of those appear, slow down and return to the workflow.
```

## How to behave after activation
For subsequent complex tasks in this session:
- spawn subagents in parallel for disjoint scopes
- use one or more reviewer subagents to validate findings from explorer subagents or to validate implementation quality
- use critic subagents only after reviewer validation, not as the primary false-positive filter
- synthesize outputs with explicit status labels such as candidate, confirmed, disproved, unverified, or pre-existing when useful
- keep the main context clean by pushing reading-heavy work into subagents

## If a task argument was provided
After enabling swarm mode, immediately execute `$ARGUMENTS` using this swarm-like implementation ladder:
1. Determine exact scope and success criteria.
2. Launch parallel exploration for disjoint investigation work.
3. Create a scoped plan.
4. Implement in coherent units.
5. Run objective verification.
6. For any worktree edit, use independent reviewer validation on the actual final diff and evidence.
7. For any worktree edit, use a separate critic challenge after reviewer approval.
8. Verify the final reviewer and critic approvals happened after the latest edit.
9. Summarize what changed, what was verified, and what risks remain.

Do not treat the presence of `$ARGUMENTS` as permission to skip the swarm-mode contract.
The task must still follow the quality, speed, and risk-tiering rules above.

## Suggested subagent prompts
When you need an explorer-style subagent, tell it:
- map the assigned scope quickly
- find candidate issues only
- be broad and suspicious
- return exact file/line references
- do not present findings as final truth

When you need a reviewer-style subagent, tell it:
- validate candidate findings from another subagent
- be hyper-critical and default to disbelief
- actively look for mitigating context that disproves each candidate
- use runtime-aware validation when safe and needed
- classify each item as CONFIRMED, DISPROVED, UNVERIFIED, or PRE_EXISTING

When you need a critic-style subagent, tell it:
- challenge reviewer-confirmed findings in small batches
- look for overclaimed severity, weak evidence, missing sibling-file checks, and poor actionability
- prefer removal over noisy weak inclusion

## Notes
- This skill enables swarm mode for the current session by writing a session file.
- It does not permanently change project behavior.
- Re-run `/swarm` if needed after clearing or resetting session context.
