# Swarm PR feedback workflow

## What changed

- Added an OpenCode-native `swarm-pr-feedback` skill for ingesting and resolving
  known pull request feedback.
- Added Codex and Claude Code adapters that delegate to the OpenCode canonical
  workflow.
- Wired PR feedback routing so review comments, requested changes, CI failures,
  conflicts, and PR follow-up work use the feedback-closure workflow instead of
  a fresh broad PR review.
- Updated related publish, review, and implementation skills to avoid unwired
  work, deferred scope, and unresolved PR feedback before closeout.

## Why

PR feedback work needs a complete intake pass before fixes begin. Review
comments, CI failures, conflicts, and pasted feedback can share one root cause,
and every item must be verified against source evidence before being accepted or
rejected.

## Migration

No user migration is required. Existing `pr-review-fix` entry points now act as
compatibility shims for `swarm-pr-feedback`.

## Known caveats

GitHub review threads are not resolved automatically. The skill leaves thread
resolution to the user unless explicitly instructed.
