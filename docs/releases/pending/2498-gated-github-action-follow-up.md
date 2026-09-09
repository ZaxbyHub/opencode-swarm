# Gated GitHub Action follow-up (issue #2498)

Hardens the gated implementation pipeline’s publication path:

- Existing pull-request detection now uses a bounded, configurable `gh pr view`
  lookup so publication cannot hang indefinitely on a stalled GitHub CLI call.
- Issue URL references now discard query strings and fragments before deriving
  the implementation branch and pull-request metadata, with regression coverage
  for fragment-bearing URLs.
- Malformed `/issues/<non-number>` references are rejected before pipeline
  side effects with the standard parse diagnostic.
