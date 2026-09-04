---
name: issue-tracer
audience: swarm-plugin
description: >
  Use when asked to trace, investigate, root-cause, reproduce, plan, fix,
  resolve, close, or prepare a PR for an issue, bug report, defect, regression,
  failing test, or confusing runtime behavior. This Claude Code adapter
  delegates to the canonical protocol at .opencode, which owns the
  Full-Resolution Contract, reproduction, reasoning-guided localization,
  no-gap fix planning, recurrence-class eradication, independent critic and
  implementation review, and PR-ready closure.
metadata:
  version: 3.0.0
---

# Issue Tracer

Follow the canonical workflow at `../../../.opencode/skills/issue-tracer/SKILL.md`.

## Claude Code Tools

- File-edit: `Edit`, `Write`, `MultiEdit`. Tasklist: `TodoWrite`. Web: `WebFetch`, `WebSearch`.
- Search: `Grep`, `Glob`, `Read`. Subagent: `Agent` (legacy alias `Task`). Bash: for scripts/git.

## Gates and Delegation

Plan critic (Phase 3), implementation review (Phase 4.5), and final critic (Phase 4.6) run via `Agent` subagent tool. Receive only diff and artifacts from the canonical protocol's `.opencode/skills/issue-tracer/references/critic-gate.md`. If `Agent`/`Task` is unavailable, record the delegation failure, run the labeled fallback, and disclose it.

## Scripts and Publication

Trace directory created by `.opencode/skills/issue-tracer/scripts/trace-init.sh <issue-slug>` (from repo root). Deferred-work gate: `.opencode/skills/issue-tracer/scripts/scan-deferred.sh`. Publication via `.claude/skills/commit-pr/SKILL.md` only when user asks to commit/push/open PR.
