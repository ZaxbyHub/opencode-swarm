---
issue: 2901
title: Wire turbo_mode as the session default and make parallelization sub-key docs truthful
type: fix
area: config
---

## What changed

- **`turbo_mode` is now wired** (issue #2901): a project config with
  `"turbo_mode": true` starts new sessions with turbo mode on. The key is
  seeded once at session construction from the session's own directory
  (`startAgentSession` / `ensureAgentSession` first-turn path), `/swarm turbo`
  remains the per-session toggle, snapshot-restored sessions keep their
  persisted value, and directory-less constructions (e.g. the recovery
  session) default to off. Previously the documented key parsed but had zero
  runtime consumers.
- **`parallelization` sub-key docs are truthful again**: `max_coders`,
  `max_reviewers`, and `evidenceLockTimeoutMs` are marked
  `[dark foundation]` — not consumed by any runtime path yet (lanes take
  concurrency from tool args and pass `evidenceLockTimeoutMs: 0`). The
  misleading "Controls agent-type concurrency limit" promise is gone; the
  generated `docs/configuration.md` row and `opencode-swarm.schema.json` were
  regenerated.
- **The config-doctor `worktree-isolation-baseline-active` advisory is
  re-keyed** onto the settings that actually drive parallel dispatch: the
  active plan's `execution_profile.parallelization_enabled` (read once via
  `loadPlanJsonOnly`, `null` when no plan is available) plus
  `worktree.policy`. Flipping the dark `parallelization` block alone no
  longer produces the "worktree isolation is already active" assurance.

## Why

The 2026-09-21 frontier audit (D1/D1b) upheld that `turbo_mode` was a
documented-but-inert config key — a recurring defect class in this repository
(#2, #1663, #2109, #2524, #2580, #2583). The maintainer disposition for this
issue was to wire it rather than deprecate it. The dark `parallelization`
sub-keys keep their schema shape for the future dispatcher wiring (tracked by
#2904 / I7) but their documentation no longer promises controls nothing
reads, and the doctor advisory now points at the plan execution profile that
actually governs parallel coder dispatch.

## Notes for reviewers

- `runConfigDoctor` gained an optional third parameter
  `planParallelizationEnabled: boolean | null` (default `null` = no plan
  available); the flag distinguishes "no plan" from "plan present with
  parallelization disabled" for future consumers even though the advisory
  treats both as no-advisory. `runConfigDoctorWithFixes` and the
  `/swarm doctor` command resolve the flag once through the shared
  seam-backed `resolvePlanParallelizationFlag` helper.
- Seeding is exercised end-to-end by
  `tests/unit/config/turbo-mode-config-seeding-2901.test.ts` (config file →
  loader → `ensureAgentSession` → constructed session), plus pins for the
  conservative legacy guard, per-session toggle precedence, directory-less
  construction, and loader-failure resilience.
