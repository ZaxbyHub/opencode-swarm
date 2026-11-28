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
  file removal reports the observed file outcome plus an explicit partial
  state with a re-run remedy, including when the record vanished concurrently.
- **Stranded quarantine payload (P3)**: a manifest write failure after the
  renames stranded moved files in a manifest-less batch that wedged every
  default rollback. The quarantine now writes a write-ahead record
  (`manifest.intent.json`) BEFORE any file moves, so a moved file has a durable
  record of its origin; if that record cannot be written, nothing is moved and
  every candidate stays at its original path. The manifest publish is
  additionally compensated with no-replace reverse commits (a hard link that
  fails with EEXIST when a concurrent writer recreated the original, so the
  winner's bytes are never overwritten), publishes a filtered recovery manifest
  on two fallback surfaces (`manifest.recovery.json` in-batch,
  `<batchId>.recovery.json` parent-sibling), and rollback resolves four manifest
  surfaces, skips wedged batches (rendered in doctor), retains a drained batch
  directory that still holds unowned files instead of deleting them (the
  ownership check and the removal are not atomic, so a file placed in the
  directory between them is not protected — that residual is an open owner
  question, not a closed one), and advances past unresolved collisions via a
  best-effort `rollback.attempted` marker, so a batch whose advancement marker
  was written does not starve an older valid batch. A batch whose compensation
  restored EVERY entry is durably marked drained, so it cannot be re-selected
  and starve an older valid batch; when that marker cannot be written, the
  write-ahead record is removed instead, which leaves the batch unreadable and
  therefore skipped. LIMIT: if the write-ahead record is itself destroyed or
  corrupted AFTER it was written, no readable surface remains — the diagnostic
  then names the batch directory and every stranded path for manual recovery
  rather than promising normal rollback. SECOND LIMIT: if a rollback in another
  process reads the write-ahead record while a quarantine is still moving
  files, it marks the batch drained and the quarantine then moves the file in,
  leaving a stored copy that neither path will ever restore — that payload
  needs manual recovery, or may be removed if it lands inside the cleanup
  window (FB-005, an open owner question). The advancement marker is itself best-effort, and
  a batch whose manifest declares an unsupported schema version makes the
  DEFAULT rollback throw rather than silently skip it.
- **Revoke window (P8)**: for structured promotion records carrying a
  `promoted_content_hash`, the promoted-file unlink now re-verifies that
  recorded digest at the destructive step (typed
  `SkillFileDigestMismatchError` refusal; boolean seam contract preserved).
  Legacy records without a recorded digest retain containment checks but skip
  the digest guard. For guarded records, a replacement promoted into the
  vacated slug BEFORE the final digest read survives the delayed revoke. The
  residual hash-read-to-unlink interval inside the helper remains non-atomic
  (narrowed, not eliminated): a replacement written inside that interval is
  not covered. An observation that the file is already absent ends the
  operation without unlinking a later occupant.
- **Retired-marker re-promotion (NF-3)**: promoting a different approved
  candidate into a retired-then-emptied slug now refuses BEFORE any mutation
  with a marker-specific diagnostic (retired/stale/dual; unretire remedy),
  instead of writing a skill the propagation gate would refuse.
- **Render hardening (#3943)**: three named clean-stage render sites (the
  post-mortem cleanup catch, the quarantine failure catch, and the active-state
  cleanup catch found by the defect-class sweep) route through
  `neutralizeResidueName`, closing the #3836/#3542 class for those three
  close-summary warnings. Each of the three now has a regression that would
  fail if its neutralization were removed. SIBLING render sinks outside this
  diff are NOT closed: `clean-stage.ts:230`, `:446` and `:535` still push
  un-neutralized interpolations into `ctx.warnings`, which
  `orchestrator.ts:712-713` writes verbatim into the close summary. Those
  are recorded as unfiled residuals, not fixed here.

Evidence: 7 frozen acceptance checks (independent author, red checkpoint
anchored on both issues before implementation, receipt re-published on each
amendment) RED to GREEN, replayed on the content this PR pushes; 14
supplementary suites (71 tests) covering the failure-branch taxonomies, the
write-ahead record, batch-directory ownership, foreign-file retention, terminal
absence, and honest partial reporting; recurrence sweep of 120 hits across 13
predicates,
covering the census's declared warning-push, warning-callback, output-append,
and close-summary warning-map sink forms, classified by the P5a–P5d predicates;
this bounded sweep does not claim every repository render sink is neutralized.
