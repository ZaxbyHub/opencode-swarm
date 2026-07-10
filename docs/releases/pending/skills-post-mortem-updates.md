# Skill documentation updates from post-mortem analysis (PRs #1721–#1762)

## What changed

- **Updated `writing-tests` skill**: Added FR-006 section documenting the 500-line test file limit with splitting patterns and bash/PowerShell line-check commands.
- **Updated `subprocess-safety` skill**: Added gh CLI subprocess patterns section covering `--slurp` for pagination, `stdin: 'ignore'`, `Number.isInteger()` timeout validation, and `maxBuffer` sizing.
- **Updated `commit-pr` skill**: Added fork PR workflow approval subsection with `gh run list` / `gh api -X POST` approve commands and cross-reference to the new `fork-pr-operations` skill.
- **Updated `swarm-pr-feedback` skill**: Added operational gotchas subsection covering `save_plan` identity changes, stale gate evidence, PowerShell `--body-file` for PR comments, and same-file batching guidance.
- **New `test-file-split` skill**: Protocol for splitting test files that exceed the 500-line FR-006 limit — covers measurement, suffix naming, helper management, extraction, and cascading co-run verification.
- **New `fork-pr-operations` skill**: Fork PR workflow operations — CI workflow approval via `gh api`, race conditions between approval and cancellation, force-push protocol, rebase strategy, stale CI verification, and multi-round bot review awareness.

## Why

Post-mortem analysis of PRs #1721–#1762 revealed recurring operational patterns and failure modes that were not documented in any skill. These updates capture that institutional knowledge so future sessions avoid repeating the same mistakes.

## Known caveats

- Infrastructure registration (skill-mirrors.ts classification, bundled-skills.ts entry, package.json#files) for the two new skills (`test-file-split`, `fork-pr-operations`) is deferred to issue #1764. `bun run drift:check` reports 4 findings (2 errors, 2 warnings) from this — all expected and tracked.
- The `gate-attribution` skill update (global user skill at `~/.opencode/skills/`) is not included in this PR as it lives outside the project repo.

## Migration

No migration required — all changes are skill documentation only.
