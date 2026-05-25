---
name: swarm
description: Codex adapter for enabling a higher-rigor swarm-like workflow in the current Codex thread. Use when the user asks for swarm mode, maximum quality, parallel investigation, extra review rigor, or a swarm-style approach without necessarily invoking the OpenCode Swarm plugin.
---

# Swarm

Read `.claude/skills/swarm/SKILL.md` for the source behavior model, then adapt it to Codex.

Codex-specific execution notes:

- Treat this as a workflow posture, not an instruction to call OpenCode `/swarm` commands.
- Use parallel local reads/searches where safe.
- Use `update_plan` for visible task tracking on substantial work.
- Add independent review pressure through `$qa-sweep`, `$swarm-pr-review`, or self-critic checks when subagents are unavailable.
- Keep the user looped in with short progress updates during longer work.

For implementation tasks, prefer `$swarm-implement`; for fresh PR review, prefer
`$swarm-pr-review`; for known PR feedback closure, prefer
`$swarm-pr-feedback`; for bug tracing, prefer `$issue-tracer`.
