---
issue: 3518,3521
---

## Shell write-gate escape classes + knowledge family migration recency (#3518, #3518 follow-ups)

Closes #3518 and #3521 (collated).

### #3518 — five shell write-gate escape classes (security)

- **Quoted process-substitution operands no longer escape the declared
  scope.** The parse-failure string fallback dequotes exactly-pair-quoted
  operands (matching the AST branch) and withdraws fragmented/unbalanced
  quoting (e.g. a quoted destination containing whitespace) to a null
  resolution — fail-closed instead of resolving an in-scope-looking fragment
  (`true >(truncate -s 0 "../../src/t.txt")` is now denied).
- **A `cd` that cannot succeed no longer moves the walker's tracked cwd.**
  The tracker stat-gates its mutation (`throwIfNoEntry` + `isDirectory`), so
  `cd nx/y; echo pwn > ../../src/f2` and the `||` form are denied; a plain
  file at the cd target behaves the same. Known edge: a failing `cd` before
  `&&` now conservatively blocks the never-executed right-side write (base
  admitted it via the phantom cwd) — fail-closed on an ambiguous shape.
- **The process-substitution fallback after a `cd` no longer resolves at the
  starting cwd.** `cd ../.. && true >(truncate -s 0 src/f)` is denied like
  its procsub-free twin (withdrawn, fail-closed). Known edge: this
  over-blocks lines that mix a working `cd` with a parse-failing process
  substitution — bounded to that shape.
- **Same-literal writes separated by a `cd` are each scope-checked at their
  own resolved path.** The #3347 occurrence-suffix is widened to every
  duplicate write (not just capability evals), so `cd src && echo x > f; cd
  ../.. && echo PWN > f` is denied at the second occurrence. Detector
  surfaces now show per-occurrence operators (`> #2`); same-cwd duplicates
  resolve identically at the gate.
- **Parenthesis-led destructive segments reach the live gate arms.** The
  rd/rmdir/del (cmd.exe), rm (POSIX), and Remove-Item (PowerShell) anchors
  tolerate a leading open-paren, closing the reversed wedge where the
  classifier denied `(rd ../../outside /s)` while the live gate admitted it.

### #3521 — knowledge family migration (data-loss class, config-ungated)

- **Same-id merges are recency-aware.** `mergeStoreEntries` and the
  append-union merge keep the NEWER version on a same-id collision
  (`updated_at` with `revision` tiebreak on the store; `updated_at` on
  unactionable; `quarantined_at` on quarantined), destination-newer
  unchanged, no-signal collisions keep the destination and are reported
  (`superseded`/`noSignal` counts added to the migration report). Within-side
  duplicate ids select the effective (newest) row. The #2958 stale-wins
  class is closed in the knowledge engine.
- **Real producer rows are keyed and survive link/unlink.**
  `knowledge-events.jsonl` rows key by `event_id` (legacy top-level `id`
  still keys); `knowledge-application.jsonl` rows use a canonical whole-row
  identity (bounded sha1, `knowledgeId` required) so distinct application
  outcomes for one entry survive while exact retries dedupe. A fresh link no
  longer silently drops source event rows and unlink copy-back no longer
  aborts the whole family migration at the pre-commit validator.

### Known edges

The string fallback remains a heuristic tokenizer (the #3491/#3088 detector
programs track the deeper rewrite); this change closes the five frozen
escape classes and widens fail-closed withdrawal to ambiguous quoting and
post-cd fallback writes.
