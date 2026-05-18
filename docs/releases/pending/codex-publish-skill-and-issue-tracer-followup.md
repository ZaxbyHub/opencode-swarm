# Codex publish skill and issue-tracer follow-up

## What changed

- Added a Codex-native `commit-pr` skill for `opencode-swarm` under `.agents/skills/commit-pr/`.
- Updated the Codex `issue-tracer` skill to treat pasted PR review findings as claims that must be validated against the live branch or PR head before editing.
- Tightened the canonical `commit-pr` workflow so existing-PR follow-up, ready-vs-draft transitions, and cancelled-check reruns are part of the documented closeout path.

## Why

This repository already had a strong publish protocol, but this run exposed a gap between Codex-native issue work and the repo's publish lifecycle. The missing Codex-side `commit-pr` skill and weaker review-follow-up guidance made the closeout path rely on ad hoc repo memory instead of a first-class local workflow.

## Migration steps

No migration required.

## Breaking changes

None.

## Known caveats

- The Codex-native `commit-pr` skill intentionally defers to `.claude/skills/commit-pr/SKILL.md` as the canonical repository publish contract, so future publish changes should keep both files aligned.
