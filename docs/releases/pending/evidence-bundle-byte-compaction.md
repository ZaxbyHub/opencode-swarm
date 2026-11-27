# `fix(evidence)`: a large evidence bundle compacts itself instead of wedging every gate save

## Summary

- `saveEvidence` enforced its `EVIDENCE_MAX_JSON_BYTES` (512 000) cap with a hard throw, while its only growth bound was the entry-count cap (100 entries, #444). For bundles whose entries are LARGE that combination is a guaranteed wedge: the `sast_scan` pseudo-task bundle (a type-global bundle every gate run appends to) carried full findings lists, ran to ~528 KB against the 512 000-byte cap, and from then on EVERY further append threw — each gate run's evidence save failed (a SAST verdict `fail` at 0 findings and 0 files scanned), `pre_check_batch` reported `gates_passed: false`, and the task fell to `rework_required` with Stage A unable to go green. Restarting, retrying, or re-scanning could not help: the wedge is in the durable stock, not the run.
- The cap check is now byte-aware compaction with an archive, in `saveEvidence` itself (no manual trimming, no authorization dance — the same "wire it programmatically" direction as the communication-log lifecycle):
  - When the appended bundle would exceed the cap, the OLDEST entries are dropped until it fits.
  - Nothing is lost: every dropped entry is appended to `evidence-archive.jsonl` BESIDE the bundle (`<taskId>/evidence-archive.jsonl`), and the archive append happens BEFORE the compacted bundle is written — an archive failure aborts the save with the bundle untouched, so compaction can never lose an entry.
  - The active archive is itself bounded: at 5 MB it rotates into a timestamped generation (`evidence-archive-<stamp>.jsonl`), and the newest 3 generations are kept.
  - A single entry that ALONE exceeds the cap still fails honestly ("exceeds maximum … even after archiving N oldest entries — a single entry alone exceeds the cap") — the caller must bound its own payload; the previous `exceeds maximum` error message remains a substring, so existing callers and tests keep matching.

## User-facing changes

- A swarm that runs for days no longer wedges on its own accumulated evidence: the next `saveEvidence` append to an over-cap bundle (e.g. the next `sast_scan` gate run) heals the stock in place — oldest entries archived, the newest state kept, the save succeeds. Tasks that had already fallen to `rework_required` because of the size throw recover through their normal retry path (`recover_rework_task` + re-run `pre_check_batch`).
- Gate verdicts remain fully provable: the newest entries stay in the active bundle (readers use last-entry semantics), and every archived entry remains on disk in the archive generations.

## Migration notes

None for consumers. Internal seams added: `src/evidence/manager.ts` `_internals` gains `appendArchive`, `archiveMaxBytes`, `archiveGenerations` (test seam, same convention as the existing `now`/`statSync` seams). The load path does not enforce the cap (unchanged) — compaction runs on the save path only.

## Discovery context

Found in the consumer-project loop (task 2.18, 2026-11-27): the consumer's `.swarm/evidence/sast_scan/evidence.json` stock stood at ~511 KB; every `pre_check_batch` appended a fresh SAST entry, crossed the cap, and the save threw — the architect reported "Evidence bundle size (528522 bytes) exceeds maximum (512000 bytes)" with a SAST verdict `fail` at 0 findings, and task 2.18 fell to `rework_required`. Pinned by `tests/unit/evidence/manager-compaction.test.ts` (5 tests: the oversized append archives its oldest entries and succeeds with the newest two kept and the dropped one in the archive; the single-entry-over-cap honest throw with nothing archived and nothing written; the archive-failure fail-closed save with the bundle untouched; the archive rotation at its bound with bounded generations; loads still work after compaction) plus the pre-existing size-limit and adversarial suites (91 tests) unchanged.
