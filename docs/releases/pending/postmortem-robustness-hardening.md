# Post-mortem robustness hardening (FR-007–011)

Internal robustness improvements to the curator post-mortem engine (`src/hooks/curator-postmortem.ts`). Observable behavior of `/swarm post-mortem` and `/swarm finalize` is largely unchanged; these fixes prevent silent failures under edge conditions.

## What changed

- **FR-008 — Report integrity check before idempotent skip:** Existing reports are now validated for structural integrity before being reused. Corrupted or empty reports are regenerated instead of being blindly returned as stale cached output. Use `--force` to bypass and regenerate unconditionally.

- **FR-009 — Concurrent-run advisory lock:** A non-blocking advisory lock prevents two concurrent post-mortem runs for the same plan from racing. The second runner logs a warning and skips instead of corrupting the report file.

- **FR-010 — Atomic report write:** Report files are now written atomically via a temp-file + rename pattern, preventing corrupted output if the process crashes mid-write.

- **FR-007 — Lesson text truncation:** Lesson text embedded in the report is truncated to 500 characters to bound report size.

- **FR-011 — Pagination caps on 5 data types:** Large knowledge stores are capped with truncation warnings across 5 data types (retrospective entries, knowledge entries, drift reports, phase digests, and proposal queue items) to prevent the post-mortem from consuming unbounded memory.

## Why

The post-mortem engine could silently produce stale or corrupted reports when: the previous run produced an empty file (crash mid-write), two finalize sessions ran concurrently on the same plan, or the knowledge store was very large. These are rare but serious edge cases that are now handled explicitly.

## Migration steps

None. The behavior changes are transparent. Reports that were corrupted due to a mid-write crash will be regenerated on the next run.

## Known caveats

- The advisory lock (FR-009) is non-blocking: the second concurrent runner skips with a warning rather than waiting. In practice this means `/swarm post-mortem` and `/swarm finalize` should not be run concurrently for the same plan.
- The pagination caps (FR-011) apply only to report generation; they do not affect the underlying knowledge store size.
