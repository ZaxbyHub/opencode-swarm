# Codebase Review Command: Bundled Skill Sync

## What changed

- Pack all built-in architect mode skills into the npm artifact: `brainstorm`, `specify`, `clarify-spec`, `resume`, `clarify`, `discover`, `consult`, `pre-phase-briefing`, `council`, `deep-dive`, `codebase-review-swarm`, `design-docs`, `swarm-pr-review`, `swarm-pr-feedback`, `issue-ingest`, `plan`, `critic-gate`, `execute`, and `phase-wrap`.
- On command invocation, materialize bundled mode skills into the private `.swarm/bundled-skills/` runtime tree before emitting first-class MODE signals, so commands such as `/swarm codebase-review`, `/swarm deep-dive`, `/swarm pr-review`, `/swarm pr-feedback`, `/swarm design-docs`, and `/swarm issue` work without overwriting same-slug repository skills.
- The sync is content-refreshing, bounded, and fail-open inside the plugin-owned runtime root: native project skill files are never destinations, unsafe symlinks are rejected, failed partial copies are rolled back, and command execution continues with a warning if the copy cannot complete.

## Why

After `/swarm codebase-review` was added as a first-class command, target repositories could emit `MODE: CODEBASE_REVIEW` but then halt when the runtime protocol had not been materialized. Runtime copies now live in the plugin-owned `.swarm/bundled-skills` tree instead of competing with project-native skills.

## Validation

- Added unit coverage for private, collision-safe bundled skill refresh across multiple mode skills.
- Added dispatch coverage proving first-class MODE commands materialize bundled skills before returning the MODE signal.
- Added package-smoke coverage requiring architect mode skill files in the packed npm artifact and rejecting unexpected files under `.opencode/skills/`.
