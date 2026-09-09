# PR-review finding confidence and terminal policy

- Added version-1 categorical finding confidence parsing, semantic same-location
  deduplication, independent provenance agreement, and conservative conflict
  handling for PR-review findings.
- Wired critic settlement, terminal readiness, final report verdict eligibility,
  exact feedback handoff membership, and canonical atomic policy evidence into
  the PR-review workflow.
- Hardened Stage-B route receipts with collision-resistant encoded identities,
  user-scoped MAC-key path checks, explicit invalid-MAC failures, and bounded
  capacity rejection before gate evidence publication.
- Preserved CRITICAL severity through persisted evidence replay, required an
  explicit severity for authenticated DOWNGRADED settlements, and disclosed
  truncated audit windows without duplicating identity events on retry.
- Added independent per-key retention for route-receipt files, including legacy
  filename shapes, so one fresh receipt cannot keep stale project receipts.
- Documented the authoritative severity/status/action/coverage-to-verdict
  matrix and the explicit degraded-micro coverage policy.

This closes issue #2491 by keeping uncertain or incomplete review evidence
visible and preventing it from being silently converted into approval.

Migration: none. Existing findings artifacts remain readable; optional
structured `confidence` and `provenance` metadata is retained when supplied.
New route receipts use encoded identity segments in filenames (with a bounded
SHA-256 component for unusually long identities); receipts are rewritten on
the next dispatch and no manual migration is required.

Known caveat: `NEEDS_MORE_EVIDENCE` remains nonterminal and therefore cannot be
represented as a terminal findings checkpoint until additional evidence is
collected.
