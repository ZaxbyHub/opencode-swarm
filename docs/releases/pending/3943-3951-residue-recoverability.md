---
---

## fix(close+skills): recoverability guards for residue quarantine, external-skill mutations, and close render sites (#3943/#3951)

Closes #3943, closes #3951 (collated follow-ups from PR #3942).

- **Lost update (P1)**: the external-skill candidate store's `update()` was an
  unlocked read-merge-write — two overlapping rejects on one candidate were
  both acknowledged while only the last writer's reason persisted. `update()`
  and `delete()` now serialize under the shared per-candidate
  `withEvidenceLock` primitive, eviction re-validates the victim's verdict
  under the victim's lock, and a revoke whose record update fails after the
  file removal reports an explicit partial state with a re-run remedy.
- **Stranded quarantine payload (P3)**: a manifest write failure after the
  renames stranded moved files in a manifest-less batch that wedged every
  default rollback. The manifest publish is now compensated with
  collision-safe reverse moves, publishes a recovery manifest on two fallback
  surfaces (`manifest.recovery.json` in-batch, `<batchId>.recovery.json`
  parent-sibling), and rollback resolves three manifest surfaces, skips wedged
  batches (rendered in doctor), and advances past unresolved collisions via a
  best-effort `rollback.attempted` marker so older valid batches are never
  starved.
- **Revoke window (P8)**: the promoted-file unlink now re-verifies the
  recorded digest at the destructive step (typed
  `SkillFileDigestMismatchError` refusal; boolean seam contract preserved), so
  a delayed revoke can no longer delete a replacement promoted into the
  vacated slug.
- **Retired-marker re-promotion (NF-3)**: promoting a different approved
  candidate into a retired-then-emptied slug now refuses BEFORE any mutation
  with a marker-specific diagnostic (retired/stale/dual; unretire remedy),
  instead of writing a skill the propagation gate would refuse.
- **Render hardening (#3943)**: the two remaining un-neutralized clean-stage
  render sites (post-mortem cleanup catch, quarantine failure catch) route
  through `neutralizeResidueName`, closing the #3836/#3542 class for the
  close-summary surface.

Evidence: 7 frozen acceptance checks (independent author, red checkpoint
anchored on both issues before implementation) RED→GREEN; 5 supplementary
suites (24 tests) covering the failure-branch taxonomies; recurrence sweep
122 hits dispositioned across 12 predicates.
