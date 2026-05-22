---
name: unswarm
description: Codex adapter for disabling a previously requested swarm-like workflow in the current thread. Use when the user says unswarm, stop swarm mode, return to normal mode, simplify the workflow, or stop using extra review/delegation rigor.
---

# Unswarm

Read `.claude/skills/unswarm/SKILL.md` only if you need the original Claude command semantics.

For Codex, this skill means:

- Stop applying `$swarm` or `$swarm-implement` as an ongoing workflow posture unless the user explicitly asks for it again.
- Keep following repository instructions, safety rules, and any task-specific skills that still apply.
- Prefer direct execution and concise updates over extra planning/review layers.
- Do not make file changes solely to "disable" swarm mode.
