## What changed

New generated skill: \git-revert-safety\ — prevents version metadata regression when reverting git commits.

## Why

The shell-write revert (commit 43fe0251) regressed \.release-please-manifest.json\ from 7.25.2 back to 7.24.1 via git reverse-apply, causing release-please to compute the wrong next version (7.25.0 instead of 7.25.3) and fail with a duplicate tag error. This skill codifies the lessons learned to prevent recurrence.

## What the skill covers

- Collateral damage assessment before reverting (manifest, package.json, CHANGELOG, lockfiles)
- Decision matrix: when to cherry-pick vs revert (8 scenarios including merge, squash, octopus)
- Post-revert verification (6 checks including cross-platform commands)
- Branch contamination recovery via clean-slate cherry-pick
- Conflict resolution gate
- CI timestamp verification before dismissing failures as pre-existing

## Migration steps

None — this is a new skill, no existing behavior changed.
