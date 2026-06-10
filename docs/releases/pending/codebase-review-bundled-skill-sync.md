# Codebase Review Command: Bundled Skill Sync

## What changed

- Pack all built-in architect mode skills into the npm artifact: `brainstorm`, `specify`, `clarify-spec`, `resume`, `clarify`, `discover`, `consult`, `pre-phase-briefing`, `council`, `deep-dive`, `codebase-review-swarm`, `design-docs`, `swarm-pr-review`, `swarm-pr-feedback`, `issue-ingest`, `plan`, `critic-gate`, `execute`, and `phase-wrap`.
- On command invocation, materialize missing bundled mode skills into `.opencode/skills/` before emitting first-class MODE signals, so commands such as `/swarm codebase-review`, `/swarm deep-dive`, `/swarm pr-review`, `/swarm pr-feedback`, `/swarm design-docs`, and `/swarm issue` work in repositories that do not already vendor the latest skill tree.
- The sync is missing-only, bounded, and fail-open: existing project skill files are not overwritten, symlinked skill roots are skipped, failed partial copies are rolled back, and command execution continues with a warning if the copy cannot complete.

## Why

After `/swarm codebase-review` was added as a first-class command, existing target repositories could emit `MODE: CODEBASE_REVIEW` but then halt because `.opencode/skills/codebase-review-swarm/SKILL.md` was not present in that repository. The same failure mode applies to any command-driven MODE whose skill is missing from a stale project-local `.opencode/skills` tree.

## Validation

- Added unit coverage for missing-only bundled skill sync across multiple mode skills.
- Added dispatch coverage proving first-class MODE commands materialize bundled skills before returning the MODE signal.
- Added package-smoke coverage requiring architect mode skill files in the packed npm artifact and rejecting unexpected files under `.opencode/skills/`.
