---
issue: 3518,3521
---

## Shell write-gate escape classes + knowledge family migration recency (#3518, #3521)

Closes #3518 and #3521 (collated).

### #3518 — five shell write-gate escape classes (security)

- **Quoted process-substitution operands no longer escape the declared
  scope.** The parse-failure string fallback dequotes exactly-pair-quoted
  operands (matching the AST branch) and withdraws — fail-closed — every
  unresolvable shape: fragmented/unbalanced quoting, quoted destinations
  containing whitespace, backslash-escaped-space operands, multi-redirect
  stages where the lazy capture only sees the last target, and any
  procsub write on a line whose text carries a `cd`/`pushd <target>` word
  (then/do/brace-led forms included).
- **An unprovable `cd` is judged at BOTH landings.** The tracked walk models
  the cd failing (cwd kept); the pessimistic walk models it succeeding at the
  bash-true target (Git Bash `/x/...` drive spellings mapped, landings
  propagated through `&&` chains and control-flow bodies) — the gate requires
  every landing to pass. A `cd` whose target the same command creates
  (`mkdir -p zz && cd zz && …`), grouped/brace/if-body cd forms, and
  Git-Bash drive paths all deny when the success landing is outside the
  declared scope. Known edge: a failing `cd` before `&&` now conservatively
  blocks the never-executed right-side write — fail-closed on an ambiguous
  shape.
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
  tolerate a leading open-paren — glued `(rd x /s)`, spaced `( rd x /s )`,
  and POSIX brace groups `{ rm -rf x; }` — closing the reversed wedge where
  the classifier denied `(rd ../../outside /s)` while the live gate
  admitted it.

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
escape classes plus the feedback-round escapes (mkdir-then-cd, grouped cd,
drive-phantom paths, torn procsub operands) and widens fail-closed
withdrawal to ambiguous quoting and post-cd fallback writes. Bare `cd`,
`cd ~`, and `popd`-adjacent directory changes remain untracked (#3491
program).
