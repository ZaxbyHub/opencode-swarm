---
name: issue-tracer
audience: swarm-plugin
description: >
  Use when asked to trace, investigate, root-cause, reproduce, plan, fix,
  resolve, close, or prepare a PR for an issue, bug report, defect, regression,
  failing test, or confusing runtime behavior. This Codex adapter's canonical
  protocol lives in .opencode and owns the Full-Resolution Contract,
  reproduction, reasoning-guided localization, no-gap fix planning, recurrence-
  class eradication, independent critic and implementation review, and PR-ready
  closure.
metadata:
  version: 2.0.0
---

# Issue Tracer

Read and follow `../../../.opencode/skills/issue-tracer/SKILL.md` as the canonical workflow.

## Codex Execution Notes

- File-edit tool: `apply_patch`. Plan/tasklist tool: `update_plan` for
  substantial work. Web tool: `web` (current external framework/API behavior,
  advisories, release notes — cite URLs). Use the shell execution tool for
  `rg`, `git`, `gh`, tests, builds, and local validation, in parallel where the
  files are independent.
- The independent critic (Phase 3), implementation review (Phase 4.5), and
  final critic (Phase 4.6) run only when a separate subagent/delegation
  mechanism is available and authorized. When none is available, record the
  unavailability and run the labeled fallback pass from
  `.opencode/skills/issue-tracer/references/critic-gate.md` ("Fallback
  self-critic/self-review/final-critic: independent … unavailable"),
  disclosed in the artifact and final response.
- For `opencode-swarm` specifically, read `AGENTS.md` and
  `docs/engineering-invariants.md` for touched invariants, use repo shell
  commands (not broad OpenCode `test_runner` scopes) for validation, and load
  `writing-tests` before changing tests.
- Trace directory and its VCS exclusion are created by the canonical
  `.opencode/skills/issue-tracer/scripts/trace-init.sh <issue-slug>` (run from
  the repo root); the deferred-work gate is
  `.opencode/skills/issue-tracer/scripts/scan-deferred.sh`.
- Publication (commit/push/PR) is governed by the repo's canonical publish
  protocol via the `commit-pr` skill (`.agents/skills/commit-pr/SKILL.md`,
  which routes to `.claude/skills/commit-pr/SKILL.md`). Switch to it only when
  the user asks to commit, push, or open/update a PR.
