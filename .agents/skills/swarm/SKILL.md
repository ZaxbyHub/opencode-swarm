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
- For any task that edits code, tests, docs, package metadata, release notes, or skill files, final completion requires:
  1. objective validation evidence,
  2. independent implementation reviewer approval on the actual latest diff,
  3. separate critic approval after reviewer approval,
  4. no unresolved `NEEDS_REVISION`/`BLOCKED` items, and
  5. no edits after those approvals.
- Record reviewer and critic verdicts in durable task artifacts. For issue-tracer
  work, use `08b-implementation-review.md` and `09-final-critic.md`; otherwise
  use task-local review artifacts unless the repo forbids artifacts.
- Explorer subagents, a plan critic, passing tests, or self-review do not satisfy the final implementation-review gate when subagent delegation is available and swarm work is authorized.

For implementation tasks, prefer `$swarm-implement`; for fresh PR review, prefer
`$swarm-pr-review`; for known PR feedback closure, prefer
`$swarm-pr-feedback`; for bug tracing, prefer `$issue-tracer`.
