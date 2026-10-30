---
issue: 2966
---

## Retired generated skills are no longer injectable; the backlog is reconciled

Explicit `SKILLS: file:` references to retired or stale generated skills are now
blocked at delegation time with a named replacement. Previously the
explicit-reference validator checked only path shape, containment, existence,
frontmatter, and audience — so a retired skill (whose `retired.marker` directory
marker discovery and routing already respected) validated and the delegation
proceeded carrying stale instructions, including a retired worktree-cleanup variant
that instructed removing the session worktree PARENT and a gate-attribution variant
that inverted the native per-task counting rule. Marker text is sanitized and
length-bounded before entering the architect-visible refusal.

Five historical slugs receive a consumer-stable replacement pointing at the bundled
canon materialized under `.swarm/bundled-skills/` (`gate-attribution`,
`merge-queue-readiness`, `skill-edit-validation`, `worktree-retry-cleanup`, and
`pr-review-fix` → `swarm-pr-feedback`); every other retired/stale slug gets an
actionable regenerate/inspect instruction. Both the symlink target's directory and
the lexical directory are checked (a marker on either side of a symlink blocks).

This repository's generated-skill backlog was reconciled: 19 retired forks and the
active bundled-slug collision `ci-failure-batching` were removed from
`.opencode/skills/generated/` (17 legitimate active forks remain), and the Codex
adapters that still designated retired forks as canonical were repointed —
`mock-to-internals-migration` is now a self-contained `.agents` canon and
`test-file-split` describes the extraction pattern inline in all three trees.
Consumer projects get the gate automatically.
