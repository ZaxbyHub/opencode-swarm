---
name: swarm-implement
description: Execute complex implementation work with a swarm-like Claude Code workflow: parallel exploration, scoped planning, selective deep validation, and independent reviewer/critic checks where risk justifies them. Use for feature work, bug fixes, refactors, and multi-file changes.
disable-model-invocation: true
---

# /swarm-implement

Use this skill for implementation work when you want Claude Code to behave like a fast, high-quality swarm rather than a single-threaded assistant.

## Purpose
Complete real coding tasks across many projects while preserving Claude Code speed and adding swarm-style quality discipline.

## Core operating model
Use this execution ladder:
1. Explore in parallel.
2. Build a scoped plan.
3. Implement in small, coherent units.
4. Run objective validation.
5. Use independent reviewer validation where the risk justifies it.
6. Use critic challenge only for high-impact or still-ambiguous results.
7. Synthesize and report what changed, what was verified, and what remains risky.

This is not a slow full-swarm recreation.
This is a speed-preserving, quality-maximizing workflow.

## Command Namespace

Swarm commands: always /swarm <subcommand> — never bare subcommand names.

CRITICAL — these CC built-ins share names with swarm commands and MUST be avoided:
  /plan → use /swarm plan (reading) or do not invoke (entering plan mode)
  /reset → NEVER invoke — wipes conversation context
  /checkpoint → NEVER invoke bare — use /swarm checkpoint <action>

HIGH — these CC built-ins produce wrong output:
  /status → use /swarm status (not CC /status)

## Quality and speed policy
- Quality and pre-ship defect detection are paramount.
- Speed still matters.
- Parallelism is the default speed lever.
- Deep validation is concentrated where bugs are expensive.
- Low-risk work should stay lightweight when extra depth would not materially improve quality.
- High-risk work must always get the deeper validation path.

## High-risk work
Always use the deeper validation path for:
- auth, authz, identity, sessions, permissions
- payments, billing, money movement, destructive actions
- dependency changes, install scripts, lockfile changes
- public API changes, schema changes, migrations
- concurrency, queues, retries, state machines, caching
- file access, subprocesses, parsing, secrets, security-sensitive logic
- large cross-file refactors with correctness risk

## Recommended workflow

### Phase 0 — Establish scope
Determine the exact task scope first:
- what changed or needs to change
- what files are likely involved
- what success looks like
- what must not be broken
- what verification is required

If the task is unclear, ask a small number of targeted questions or create a short written plan before coding.

### Phase 1 — Parallel exploration
Launch parallel subagents for disjoint investigation tasks such as:
- repository mapping for relevant subsystems
- locating existing patterns to follow
- finding tests, schemas, contracts, and integration points
- identifying likely side effects and touched modules
- checking dependency or migration implications

Do not use the main thread for broad repo reading if subagents can do it.
Keep the main context focused.

### Phase 2 — Plan
Create a concrete implementation plan before editing for any non-trivial task.
The plan should include:
- files to change
- intended behavior
- risks and likely regressions
- validation commands
- whether reviewer and critic passes will be required

### Phase 3 — Implement in scoped units
Implement in coherent, reviewable chunks.
Avoid giant speculative rewrites.
Follow existing repository patterns unless there is a strong reason not to.

### Phase 4 — Objective validation
Always run the strongest objective checks available for the task:
- tests
- lint
- typecheck
- build
- targeted repro scripts
- local runtime verification where relevant

If you cannot verify it, do not claim it is done.

### Phase 5 — Independent reviewer validation
Use an independent reviewer subagent when the task is:
- high-risk
- cross-file
- behavior-sensitive
- likely to hide edge-case bugs
- security-sensitive
- likely to produce false confidence from the implementation context

Reviewer responsibilities:
- inspect the implementation with fresh context
- look for correctness bugs, edge cases, regressions, claim-vs-actual mismatches, and test blind spots
- be hyper-critical and suspicious
- default to disbelief until evidence supports the change
- identify whether issues are CONFIRMED, DISPROVED, UNVERIFIED, or PRE_EXISTING when useful

### Phase 6 — Critic challenge
Use a critic subagent only when needed:
- reviewer found high-impact issues
- confidence is still borderline
- the change touches high-risk systems
- the implementation appears polished but may hide requirement drift or false confidence

Critic responsibilities:
- challenge reviewer-confirmed findings
- look for severity inflation, weak evidence, missing sibling-file checks, and poor actionability
- prefer removing weak claims over adding noise

### Phase 7 — Final synthesis
In the main thread, summarize:
- what changed
- what was verified
- what reviewers found
- what critic challenged
- final remaining risks
- whether the task is actually complete

## Hard rules
- Do not let implementation context self-approve high-risk work.
- Do not skip reviewer validation for high-risk work.
- Do not skip objective verification because the code looks right.
- Do not let perceived repo size or task size compress the workflow.
- If quality and speed conflict, quality wins.
- If extra validation does not materially improve quality, keep the path lightweight.

## Suggested subagent prompts

### Explorer-style
Use for broad discovery:
- map the assigned subsystem quickly
- identify likely files, patterns, contracts, tests, and risks
- return a concise actionable summary
- do not edit code

### Reviewer-style
Use for implementation validation:
- review the implementation with fresh context
- be hyper-critical and suspicious
- look for edge cases, regressions, hidden coupling, and claimed-vs-actual mismatches
- verify whether the tests actually prove behavior
- return only high-signal findings

### Critic-style
Use for final challenge:
- challenge high-impact conclusions
- check whether findings are overclaimed or weakly evidenced
- challenge severity and actionability
- look for what the previous layer may have missed

## Use across many repos
This skill is intentionally project-agnostic.
It should adapt to each repository by exploring first, following local patterns, and scaling validation depth to actual risk.
