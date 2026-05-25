# CI engineering invariant checks and post-merge closeout

## What changed

- Added `scripts/check-invariants.sh` — a bash CI check that enforces three
  grep-based engineering invariants from AGENTS.md:
  1. **Subprocess timeout** (advisory): warns on files using `spawn`/`spawnSync`
     without `timeout`/`timeoutMs`
  2. **process.cwd() ban**: blocks new `process.cwd()` usage in `src/tools/`
     and `src/hooks/` (7 legacy files exempted)
  3. **mock.module allowlist**: blocks new `mock.module` targets not in
     `scripts/mock-allowlist.txt` — exact-match with normalization, multiline
     bypass detection, comment filtering
- Added `scripts/mock-allowlist.txt` — complete baseline of 53 unique
  normalized `mock.module` targets (one per path after deduplication)
- Added `.opencode/skills/generated/subprocess-safety/SKILL.md` — generated
  skill codifying AGENTS.md Invariant 3 (subprocess safety) as an actionable
  coder reference
- Added `.opencode/skills/generated/git-revert-safety/SKILL.md` — generated
  skill for safe git revert patterns

## Why

Post-merge closeout for PR #1019 (plan state integrity fix #976). The skill
improver identified three recommendations (R1, R3, R5) to prevent recurring
violations of the engineering invariants that caused the original bug.

## Migration steps

None. The CI check runs automatically in the `quality` job on every PR.
To add a new `mock.module` target, add the normalized path to
`scripts/mock-allowlist.txt`.

## Breaking changes

None.

## Known caveats

- Check 1 (subprocess timeout) is advisory-only — file-level, not call-level.
  Individual unbounded spawns within files that have `timeout` elsewhere will
  not be caught by this grep-based check.
- The `mock.module` allowlist must be manually maintained when new test mocks
  are added.
