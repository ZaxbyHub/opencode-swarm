---
name: swarm
audience: swarm-plugin
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

These are invoked as `/swarm <subcommand>`, NOT as bare `/subcommand`. The list below is generated from the `COMMAND_REGISTRY` (`src/commands/registry.ts`) and includes all registered non-deprecated base commands and subcommands:

**Core / state**

- `/swarm status` — show current swarm state
- `/swarm show-plan` — show current plan (optionally filter by phase number)
- `/swarm plan` — deprecated alias for `/swarm show-plan`
- `/swarm agents` — list registered agents
- `/swarm help` — show help for swarm commands (optionally `[command]`)
- `/swarm history` — show completed phases summary
- `/swarm config` — show current resolved configuration
- `/swarm export` — export plan and context as JSON
- `/swarm evidence` — show evidence bundles `[taskId]`
- `/swarm evidence summary` — generate evidence summary with completion ratio and blockers
- `/swarm evidence-summary` — deprecated alias for `/swarm evidence summary`
- `/swarm handoff` — prepare state for clean model switch
- `/swarm archive` — archive old evidence bundles `[--dry-run]`
- `/swarm retrieve` — retrieve full output from a summary `<id>`
- `/swarm rollback` — restore swarm state or project files to a checkpoint
- `/swarm reset` — clear swarm state files `[--confirm]`
- `/swarm reset-session` — clear session state, preserve plan/evidence/knowledge
- `/swarm recover` — settle wedged coder settlements `[task_id] [--force]` (human-only)
- `/swarm checkpoint` — manage project checkpoints `[save|restore|delete|list] <label>`
- `/swarm finalize` — finalize the swarm project and archive evidence
- `/swarm close` — deprecated alias for `/swarm finalize`
- `/swarm auto-proceed` — toggle or set auto-proceed override `[on|off]`
- `/swarm concurrency` — manage runtime concurrency override `[set|status|reset]`

**Diagnostics / health**

- `/swarm diagnose` / `/swarm diagnosis` — run health check on swarm state (`diagnosis` is a deprecated alias)
- `/swarm config doctor` — run config doctor checks
- `/swarm config-doctor` — deprecated alias for `/swarm config doctor`
- `/swarm doctor` — deprecated alias for `/swarm config doctor`
- `/swarm doctor tools` — run tool registration coherence check
- `/swarm doctor-tools` — deprecated alias for `/swarm doctor tools`
- `/swarm preflight` — run preflight automation checks
- `/swarm lanes` — list active, awaiting-merge, and conflicted worktree lanes
- `/swarm sync-plan` — ensure plan.json and plan.md are synced
- `/swarm benchmark` — show performance metrics `[--cumulative] [--ci-gate] [--max-cost-usd <n>]`
- `/swarm review` — run the independent review model against a selected Git diff
- `/swarm costs` — show per-agent and per-task token/cost telemetry `[--json]`
- `/swarm learning` — show learning metrics and violation trends
- `/swarm guardrail explain` — dry-run: show what guardrails would do (executes nothing)
- `/swarm guardrail-explain` — deprecated alias for `/swarm guardrail explain`
- `/swarm guardrail-log` — read the guardrail decision log
- `/swarm coupling` — measure plan coupling and rank modules driving conflicts
- `/swarm dark-matter` — detect hidden file couplings via co-change NPMI analysis
- `/swarm simulate` — dry-run hidden coupling analysis with configurable thresholds
- `/swarm ci-simulate` — create a temporary merge-result worktree and run CI pre-merge
- `/swarm qa-gates` — view or modify QA gate profile for the current plan
- `/swarm acknowledge-spec-drift` — acknowledge spec drift and suppress further warnings

**Knowledge / memory / curation**

- `/swarm knowledge` — list knowledge entries
- `/swarm knowledge migrate` — migrate knowledge entries to the current format
- `/swarm knowledge quarantine` — move a knowledge entry to quarantine
- `/swarm knowledge restore` — restore a quarantined or archived knowledge entry
- `/swarm knowledge unactionable` — list unactionable knowledge entries pending hardening
- `/swarm knowledge retry-hardening` — reset retire candidates for re-hardening
- `/swarm knowledge hive-quarantine` — human-only exact-ID quarantine of hive-store entries with backup and rollback (issue #2033)
- `/swarm memory` — show Swarm memory commands
- `/swarm memory status` — show Swarm memory provider, JSONL, and migration status
- `/swarm memory pending` — show pending Swarm memory proposals
- `/swarm memory recall-log` — summarize Swarm memory recall usage
- `/swarm memory value-log` — show Swarm memory Q-value and reward updates
- `/swarm memory compact` — compact deleted/superseded/expired scratch memories
- `/swarm memory stale` — list stale and low-utility Swarm memories
- `/swarm memory export` — export current Swarm memory to JSONL files
- `/swarm memory evaluate` — run golden Swarm memory recall evaluation fixtures
- `/swarm memory audit-verify` — verify the memory audit-log hash chain (tamper detection)
- `/swarm memory import` — import legacy JSONL memory into SQLite
- `/swarm memory migrate` — run the one-time legacy JSONL to SQLite migration
- `/swarm memory consolidation-log` — summarize recent memory consolidation passes
- `/swarm memory link` — share memory across linked worktrees (requires `memory.link.enabled`)
- `/swarm memory link status` — show whether memory is cohort-linked (distinct from knowledge link)
- `/swarm memory unlink` — stop sharing memory; copies cohort family back to local
- `/swarm curate` — run knowledge curation and hive promotion review
- `/swarm consolidate` — run quota-bounded skill-improver consolidation
- `/swarm promote` — manually promote a lesson to hive knowledge
- `/swarm link` — tie this worktree to a shared swarm knowledge store
- `/swarm link status` — show whether this worktree shares knowledge via a link
- `/swarm unlink` — stop sharing swarm knowledge for this worktree
- `/swarm write-retro` — write a retrospective evidence bundle for a completed phase
- `/swarm skill-opt` — governed single-skill optimizer (plan|run|status|diff|approve|reject|rollback|history); disabled by default (`skill_opt.enabled`)
- `/swarm skill-opt plan` — propose an optimization round (dry-run; no mutation)
- `/swarm skill-opt run` — execute the optimization loop (requires `skill_opt.enabled=true` and `--confirm`)
- `/swarm skill-opt status` — show the current candidate lifecycle state
- `/swarm skill-opt diff` — show baseline-vs-candidate diff summary for a candidate
- `/swarm skill-opt approve` — activate a pending candidate (human-only; requires `--expected-content-hash`)
- `/swarm skill-opt reject` — record a rejection for a candidate (no active-skill mutation)
- `/swarm skill-opt rollback` — restore the pre-activation snapshot (appends a rolled_back event)
- `/swarm skill-opt history` — show the append-only lifecycle event log for a candidate

**Architect MODE workflows**

- `/swarm brainstorm` — enter architect MODE: BRAINSTORM (seven-phase planning)
- `/swarm loop` — enter architect MODE: LOOP (compound-engineering loop)
- `/swarm council` — enter architect MODE: COUNCIL (multi-model deliberation)
- `/swarm clarify` — clarify and refine an existing feature specification
- `/swarm specify` — generate or import a feature specification
- `/swarm analyze` — analyze spec.md vs plan.md for requirement coverage gaps
- `/swarm sdd` — manage OpenSpec-compatible SDD artifacts
- `/swarm sdd status` — show OpenSpec-compatible SDD status
- `/swarm sdd validate` — validate OpenSpec-compatible artifacts
- `/swarm sdd project` — materialize the effective spec into `.swarm/spec.md`
- `/swarm epic` — toggle Epic Mode (autonomous coupling-aware parallel activation)
- `/swarm turbo` — toggle Turbo Mode strategy `[on|off|lean|standard|epic|status]`
- `/swarm full-auto` — toggle Full-Auto Mode; accepts `on [mode]`, `off`, or `status`
- `/swarm guardrail reset` — reset an action-local guardrail circuit after external repair
- `/swarm post-mortem` — run the post-mortem agent (project-end synthesis)

**Read-only audits / research**

- `/swarm deep-dive` / `/swarm deep dive` — launch deep codebase audit (parallel explorers, dual reviewers, critic)
- `/swarm deep-research` / `/swarm deep research` — launch cited multi-source deep research pass
- `/swarm codebase-review` / `/swarm codebase review` — run codebase-review-swarm
- `/swarm design-docs` / `/swarm design docs` — generate or sync language-agnostic design docs

**PR / issue workflows**

- `/swarm issue` — ingest a GitHub issue (intake → localization → resolution spec) [--plan] [--trace] [--no-repro]
- `/swarm pr-review` — launch deep PR review with multi-lane analysis
- `/swarm pr-feedback` — ingest and close known PR feedback (review comments, CI failures, conflicts)
- `/swarm abort-pr-workflow` — clear a stuck PR_REVIEW/PR_FEEDBACK mechanical gate and stop the auto-resume loop (human-only escape hatch)
- `/swarm approve-plan-critic` — record a MANUAL plan-critic approval to unblock the ratchet-tighter critic_pre_plan execution gate when the critic already returned APPROVED but the snapshot was not recorded (human-only escape hatch)
- `/swarm approve-write` — issue one exact, session-bound, one-shot write approval for a candidate action and content hash (human-only)
- `/swarm ci-monitor` — drive an already-reviewed, approved PR to green and merged (monitor CI, fix, merge; max 5 fix cycles)
- `/swarm pr subscribe` / `/swarm pr-subscribe` — subscribe session to PR state-change notifications
- `/swarm pr unsubscribe` / `/swarm pr-unsubscribe` — unsubscribe session from PR notifications
- `/swarm pr status` / `/swarm pr-status` — show PR monitor subscription status

### CRITICAL NAMING CONFLICTS

These swarm subcommands share exact names with CC built-in commands.
Invoking the bare form instead of `/swarm <name>` causes irreversible damage:

| Swarm Command | CC Built-in | Damage |
|---|---|---|
| `/swarm plan` | CC `/plan` | Enters CC plan mode — blocks execution |
| `/swarm reset` | CC `/reset` | Wipes entire conversation context |
| `/swarm checkpoint` | CC `/checkpoint` | Reverts conversation history |
| `/swarm history` | CC `/history` | Shows CC conversation history instead of swarm phase history |

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

## Behavior model

The canonical swarm behavior model (goal, workflow posture, quality/speed policy, default triage model, and the **mandatory implementation closeout gate**) lives at `.opencode/skills/swarm/SKILL.md`. This file holds only the Claude Code `/swarm` command wiring above; the cross-agent contract is canonical.
