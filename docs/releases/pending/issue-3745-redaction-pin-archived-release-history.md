---
issue: 3745
---

# redaction-surfaces-3710 unit pin re-pointed at the archived release history

## What changed

- The second test in `tests/unit/failures/redaction-surfaces-3710.test.ts` no
  longer reads the rotating `docs/releases/pending/` directory. It now pins
  the #3710-3712 redaction-hardening fragment content in the ARCHIVED release
  history: the section markers in `docs/releases/v7.204.9.md` (the
  "Redaction-family hardening" section with its three #3710/#3712 subsections
  and the `sanitizeFailureEvidenceDisplay` seam) plus the consumed-fragment
  provenance in `docs/releases/manifests/v7.204.9.json` (`fragments[].sha256`
  for `3710-3712-redaction-hardening.md`).
- Same shape as the #3509 precedent
  (`tests/unit/hooks/review-route-seams-3509.test.ts` pins its archived
  content against `docs/releases/v7.201.1.md`). Future redaction work authors
  its own fragment and adds its own NEW archived pin at authoring time.

## Why

Pending fragments are rotating artifacts: every release materializes and
deletes them. The old assertion ("at least one file under
`docs/releases/pending/` matches `/(3710|3711|3712|redaction)/i`") broke the
repo-wide `unit` gate the moment the last matching fragment was consumed —
observed live when PR #3737's merge-group CI run failed after v7.204.9
consumed `3710-3712-redaction-hardening.md`, and the pin only passed again
because the newer `3730-3736-redaction-fill-tolerance-jwt-shapes.md` fragment
(#3742) happened to match the `redaction` alternation. Issue #3745.

## Migration steps

None. Test-only change; no runtime, config, or tool surface moved.

## Known caveats

- The archived pin is version-anchored (`v7.204.9`): if the archived release
  history were ever regenerated or restructured, this test fails loudly and
  the pin must be re-pointed deliberately — that is the intended fail-closed
  behavior, not a regression.
- The fill-byte matrix test in
  `tests/unit/failures/tool-failure-classification.test.ts` ("never leaks a
  secret for any single or adjacent-pair fill-byte insertion…") exceeds the
  5 s default bun test timeout on slow hosts; it fails identically on clean
  `origin/main` (verified with the fix stashed) and is unrelated to this
  change.
