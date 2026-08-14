Present the eleven gates with their defaults (DEFAULT_QA_GATES), parallel coder count, commit frequency, and auto_proceed as a single user-facing section. Offer the user a one-shot choice: accept defaults, or customize. The eleven gates are:
- reviewer (default: ON) - code review of coder output
- test_engineer (default: ON) - test verification of coder output
- sme_enabled (default: ON) - SME consultation during planning/clarification
- critic_pre_plan (default: ON) - critic review before plan finalization
- sast_enabled (default: ON) - static security scanning
- council_mode (default: OFF) - replaces per-task Stage B (reviewer + test_engineer) with the full 5-member council (critic, reviewer, sme, test_engineer, explorer). Requires council.enabled: true in config.
- hallucination_guard (default: OFF) - when enabled, mandatory per-phase API/signature/claim/citation verification at PHASE-WRAP; phase_complete will REJECT phase completion unless .swarm/evidence/{phase}/hallucination-guard.json exists with an APPROVED verdict.
- mutation_test (default: OFF) - when enabled, runs mutation testing on source files touched this phase via generate_mutants + mutation_test + write_mutation_evidence at PHASE-WRAP; FAIL verdict blocks phase_complete; WARN is non-blocking.
- phase_council (default: OFF) - full 5-member council reviews all work in a phase holistically at phase_complete time. Requires council.enabled: true in config.
- drift_check (default: ON) - mandatory per-phase drift verification via critic_drift_verifier at PHASE-WRAP; hard-blocks phase_complete when spec.md exists and drift evidence is missing or REJECTED; advisory-only when no spec.md exists.
- final_council (default: OFF) - when enabled, after all phases complete the architect dispatches the full 5-member council (critic, reviewer, sme, test_engineer, explorer) - NOT the General Council - at project scope, collects `CouncilMemberVerdict` objects, and calls `write_final_council_evidence`. This does not require `council.general.enabled`.

Additionally, present these three sub-items as part of the same exchange:
- Parallel coders (default: 1, range: 1-6) - how many coders should run in parallel. Parallel coders each run in an isolated git worktree (separate working dir + branch) and merge back automatically, so they never overwrite each other's files - safe and faster, but only for tasks whose declared file scopes do NOT overlap. Inspect the drafted plan and recommend the number of dependency-ready, file-disjoint task groups, clamped to 1-6; recommend 1 when scopes overlap or are unknown.
  > COMMON MISCONCEPTION: worktree isolation is baseline for standard parallel coders, governed by the parallel execution profile plus top-level `worktree.policy`. It is not provided by Lean Turbo or Epic. Do not recommend Lean Turbo or Epic to obtain worktree isolation; recommend them only for what they add beyond baseline (Lean Turbo: lane planning, file locks, phase reviewer, integrated diff; Epic: co-change awareness and auto-decide). Worktrees also do not make overlapping scopes safe: dependency readiness, file-disjoint scopes, and merge-back ownership are still required.
- Commit frequency (default: phase-level only) - optional per-task checkpoint commit after each task completion.
- auto_proceed (boolean, default: false) - when true, auto-advance to the next phase without asking "Ready for Phase N+1?"; runtime toggle via /swarm auto-proceed on|off.
