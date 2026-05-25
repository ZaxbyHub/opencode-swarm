# Skill workflow CI and review hardening

## What changed

- Updated the canonical `commit-pr` skill to require current-head (`headRefOid`) check verification after follow-up pushes.
- Added guidance for handling obsolete older-head CI runs that block concurrency, including inspecting run metadata before cancellation.
- Added `dist-check` recovery guidance for source-touching PRs when stale dependency output causes local-vs-CI `dist/` drift.
- Updated `pr-review-fix` guidance to require reconciling bot/app review comments with bot-pushed commits and current branch code.
- Updated `running-tests` guidance for Windows `EPERM` after forced Bun dependency refresh, with retry expectations under approved/elevated access.
- Synced the corresponding Codex adapter skill notes with the same operational rules.

## Why

Recent PR follow-up sessions exposed repeatable failure modes around stale CI runs, ambiguous bot reviews, and host-specific Bun access errors. Encoding these procedures in the skills reduces false diagnostics and speeds up safe PR closeout.

## Migration steps

None.

## Known caveats

None.
