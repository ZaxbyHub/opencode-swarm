# Deferred-work scanner: bare markers are now word-bounded (no false positive on identifier-shaped letter-runs)

## What

The issue-tracer deferred-work scanner
(`.opencode/skills/issue-tracer/scripts/scan-deferred.sh`) no longer flags
identifier-shaped content that merely CONTAINS a bare marker's letter-run.
The four bare-word markers in its pattern now carry word boundaries on BOTH
sides; the long-form markers keep their original unbounded form (the
trailing `!` or the identifier tail already discriminates them).

- Verified false positive (zmem #309): the env-var name
  `ZMEM_MODEL_AUTODOWNLOAD` embeds the first marker's letter-run mid-word
  (between its `AU-` and `-WNLOAD` halves), so every added line setting that
  env var — CI env blocks, test fixtures — fired the scan and left
  trace-check phase 4 red until each hit was hand-dispositioned.
- The first marker keeps an optional plural via `s?` so a leading
  list-header shape (`# <marker>s:`) still hits — a plain boundary pair
  without the `s?` would silently drop it, because `s` is a word character
  and would eat the trailing boundary.
- The marker text in the script is assembled from quoted halves on the two
  assignment lines, so the diff introducing the pattern cannot trip the very
  gate it tightens (the script scans its maintainer's diffs too).
- The full-resolution contract's clause 2 (no deferred work) now points at
  the scanner itself —
  `bash .opencode/skills/issue-tracer/scripts/scan-deferred.sh origin/<default-branch>`
  — single-sourcing the pattern that was previously duplicated as a grep
  one-liner in the document, which also keeps the document's own diff free
  of literal marker tokens.
- 11 new regression cases in `tests/unit/scripts/scan-deferred.test.ts`:
  4 stay-clean shapes (the exact zmem #309 env-var line, marker letters
  mid-identifier, marker as identifier suffix, marker underscore-wrapped)
  and 7 still-hit shapes (each bare marker, the plural list-header form, the
  long-form identifier marker, the rust-style bang marker). Every marker
  literal in the test file is likewise assembled from string fragments so
  the suite's own diff stays clean under the fixed scanner.

## Why

A real marker always keeps a non-word character (or line end) on each side —
`# <marker>`, `//<marker>:`, `<marker>:` all still hit — while an
identifier-embedded letter-run never does. The old unbounded alternation
could not tell those apart, so ordinary environment-variable and identifier
names produced gate failures that required manual FALSE_POSITIVE
dispositions on every affected PR.

## Caveats

- A marker letter-run fully embedded inside an identifier (no boundary on
  either side) is no longer reported. That is the false-positive class this
  change deliberately removes; the old behavior is recoverable only by
  quoting the hit literally in a comment shape that carries boundaries.
- The plural `s?` exception applies only to the first bare marker; the other
  three bare markers have no plural form in practice and none was added.
