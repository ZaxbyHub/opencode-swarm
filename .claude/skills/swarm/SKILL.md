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

## Behavior model

The canonical swarm behavior model (goal, workflow posture, quality/speed policy, default triage model, and the **mandatory implementation closeout gate**) lives at `.opencode/skills/swarm/SKILL.md`. This file holds only the Claude Code `/swarm` command wiring above; the cross-agent contract is canonical.
