---
name: issue-tracer
audience: swarm-plugin
description: >
  Use when asked to trace, investigate, root-cause, reproduce, plan, fix,
  resolve, close, or prepare a PR for an issue, bug report, defect, regression,
  failing test, or confusing runtime behavior. This Claude Code adapter's
  canonical protocol lives in .opencode and owns the Full-Resolution Contract,
  reproduction, reasoning-guided localization, no-gap fix planning, recurrence-
  class eradication, independent critic and implementation review, and PR-ready
  closure.
metadata:
  version: 2.1.0
---

# Issue Tracer

Read and follow `../../../.opencode/skills/issue-tracer/SKILL.md` as the
canonical workflow.

## Claude Code Execution Notes

- File-edit tool: `Edit` / `Write` / `MultiEdit`. Plan/tasklist tool:
  `TodoWrite`. Web tool: `WebFetch` / `WebSearch`. Repository search: `Grep` /
  `Glob` / `Read` (use them in parallel for independent files).
- Independent gates (Phase 3 plan critic, Phase 4.5 implementation review,
  Phase 4.6 final critic) use the `Agent` / `Task` subagent tool. Launch a
  separate context for each; give the reviewer only the diff and the artifacts
  named in the canonical
  `.opencode/skills/issue-tracer/references/critic-gate.md`, never your own
  reasoning narrative.
- When running AS the `.claude/agents/issue-tracer.md` subagent, nested
  subagent tools may be absent from that context. Check the actual tool list
  rather than assuming: if `Agent`/`Task` is genuinely unavailable, record
  that as the delegation failure, run the labeled fallback pass from
  `.opencode/skills/issue-tracer/references/critic-gate.md` ("Fallback
  self-critic/self-review/final-critic: independent … unavailable"), and
  disclose it in the artifact and final response.
- Trace directory and its VCS exclusion are created by the canonical
  `.opencode/skills/issue-tracer/scripts/trace-init.sh <issue-slug>` (run from
  the repo root; writes `.git/info/exclude`); the deferred-work gate is
  `.opencode/skills/issue-tracer/scripts/scan-deferred.sh`.
- Publication (commit/push/PR) is governed by the repo's canonical publish
  protocol, `.claude/skills/commit-pr/SKILL.md`. Switch to that skill only when
  the user asks to commit, push, or open/update a PR, and only after confirming
  there are no unrelated changes.
