# `feat(skills)`: subagent orchestration, session durability, and skill-editing guidance for Claude Code

## Summary

- Added **`.claude/skills/orchestrating-subagents/`** — tiering guidance for delegating to subagents: which agent type, model, and effort to use per role (explorer, implementer, reviewer, critic), fan-out discipline, scoped subagent prompt contracts, and approval-staleness rules. Never tiers the reviewer/critic below the session's own model or effort.
- Added **`.claude/skills/durable-session-state/`** — a four-file artifact protocol (plan / decisions / evidence / gates ledger, each stamped with the `HEAD` commit and diff at approval time) so long or multi-phase swarm-mode sessions survive context compaction and resume correctly, and so "any edit invalidates prior reviewer/critic approval" is mechanically checkable instead of memory-dependent.
- Added **`.claude/skills/editing-skills/`** — the contract for adding, editing, moving, or removing any `SKILL.md` in this repo's four skill trees (`.opencode`, `.claude`, `.agents`, `.github`): mirror classification via `src/config/skill-mirrors.ts`, dual-tree byte-identical edit requirements, `bun run drift:check`, bundling via `BUNDLED_PROJECT_SKILLS`, and the `.agents/skills/<slug>/` Codex shim orphaning hazard on rename/move/remove.
- Fixed `.claude/skills/rust-crate-ci/SKILL.md` local validation commands to match `.github/workflows/ci.yml`'s `rust-sandbox-runner` job exactly (was missing `--all-targets` on `clippy`/`test`, so a local pass could still fail CI).
- Fixed `.claude/skills/tech-debt-ci-review/SKILL.md` to stop writing its report to the repo root.
- Rewrote `.claude/skills/research-first/SKILL.md` to actually work under its `context: fork` / `agent: Explore` execution mode (no assumption of write access or nested subagent spawning; explicit offline/no-network fallback).
- Added a risk-proportionality note to `.claude/skills/qa-sweep/SKILL.md` that explicitly does not dilute the swarm-mode contract's separate independent reviewer and critic gates.
- Closed a dangling cross-skill reference in `.claude/skills/swarm-implement/SKILL.md`'s Phase 0a fallback branch.
- Clarified the subagent-nesting note in `orchestrating-subagents` and `qa-sweep` to a capability check (verify an `Agent`/`Task` tool is actually available) rather than an absolute "subagents cannot spawn subagents" claim.
- Fixed a stale skill path in `AGENTS.md` (`willing-tests` → `writing-tests`).
- Fixed the repo's `.claude/settings.json` `Stop` hook: the prior prompt told the model to check an "environment variable" for `stop_hook_active`, which a `type: "prompt"` hook never sees that way (only `$ARGUMENTS` interpolates the hook's JSON input). The hook now explicitly interpolates `$ARGUMENTS`, checks `stop_hook_active` correctly, returns `{"ok": true}` when the session is legitimately waiting on an external event (a background subagent, a user question, a scheduled wakeup) instead of forcing continuation on a turn with nothing left to do, and scales its five-criteria completion gate to the actual size/risk of the task instead of applying full swarm-mode scrutiny unconditionally.

## User-facing changes

None to runtime plugin behavior — this is a documentation/skill and local-harness-config change only. Claude Code sessions in this repo get more accurate local skill guidance and a Stop hook that no longer busy-loops while background subagents are running.

## Migration notes

None required. `.claude/skills/` and `.claude/settings.json` are repo-local; they are not published to npm (`package.json#files` only lists `.opencode/skills/**`) and are not synced into other projects.

## Discovery context

Produced via a swarm-mode skills audit: three parallel Explore agents covering Claude-only skills, mirrored architect-mode skills, and repo validation/bundling tooling, followed by a Claude Code hooks-and-skill-mechanics research pass. All candidate findings were validated by an independent implementation reviewer (round 1: `NEEDS_REVISION` with 5 items, all fixed; round 2: `APPROVE`) and a separate final critic (`APPROVE`) before the skill changes were pushed. The Stop hook fix was researched directly against `https://code.claude.com/docs/en/hooks` and `https://code.claude.com/docs/en/hooks-guide` (quoted verbatim, not inferred) after a first-pass research subagent's report was found to include unverifiable/likely-hallucinated fields (`agent_id`, `agent_type`, `stop_reason`) that were rejected rather than trusted.
