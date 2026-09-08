# PR-review finding confidence and terminal policy

- Added version-1 categorical finding confidence parsing, semantic same-location
  deduplication, independent provenance agreement, and conservative conflict
  handling for PR-review findings.
- Wired critic settlement, terminal readiness, final report verdict eligibility,
  exact feedback handoff membership, and canonical atomic policy evidence into
  the PR-review workflow.
- Documented the authoritative severity/status/action/coverage-to-verdict
  matrix and the explicit degraded-micro coverage policy.

This closes issue #2491 by keeping uncertain or incomplete review evidence
visible and preventing it from being silently converted into approval.

Migration: none. Existing findings artifacts remain readable; optional
structured `confidence` and `provenance` metadata is retained when supplied.

Known caveat: `NEEDS_MORE_EVIDENCE` remains nonterminal and therefore cannot be
represented as a terminal findings checkpoint until additional evidence is
collected.
