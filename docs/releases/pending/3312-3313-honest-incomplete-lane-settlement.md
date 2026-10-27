---
issue: 3312
---

# Honest INCOMPLETE lane settlement for PR reviews

PR-review workflows now settle their lanes truthfully instead of wedging: a
run that cannot finish validating can complete as INCOMPLETE with a durable
disclosure, lanes that produced provable evidence settle at collection time,
and the lane-liveness watchdog is on by default.

- **PR_REVIEW completion gains an honest INCOMPLETE exit** for COMPLETE and
  PARTIAL runs. When a reviewer/critic/council validation phase cannot
  settle, `complete_pr_workflow` may complete with `report_verdict:
  "INCOMPLETE"` once every lane is settled and the workflow is still bound
  to the PR head; the gate persists a durable validation-skip disclosure
  artifact (`.swarm/pr-review/<runId>/validation-skip-disclosure.json`) plus
  gate-state mirror fields before the terminal clear, and emits an audit
  event naming each skipped phase and its unsettled items. APPROVE and
  REQUEST_CHANGES are never admitted through this exit — an honest
  INCOMPLETE never claims code-quality approval.
- **Partial-coverage disclosure admission is retry-first**: while a
  contract-class failure still has unconsumed retry budget, the disclosure
  admission refuses and tells you to spend the retry first. Re-running
  affected dimensions after exhaustion supersedes the previously admitted
  disclosure only for the same dimension tuple, and every supersession is
  audited (`pr_review_coverage_disclosure_superseded`); a different
  disclosure tuple is still refused.
- **NO_COVERAGE completion retries reuse the admitted run id**, so a retry
  after a failed terminal clear replays the disclosure idempotently under
  the same `.swarm/pr-review/<runId>/` directory instead of minting a fresh
  id and colliding with the existing disclosure.
- **Cross-lane duplicate finding ids are rejected at receipt publish**:
  `submit_pr_review_result` refuses a finding id already claimed by another
  lane of the same run before any state write.
- **Stale-revision base dimensions disclose as PARTIAL**: under exhausted
  staged resilience, a base dimension whose lane settled against a stale
  revision is disclosed as PARTIAL coverage rather than blocking the
  settlement.
- **Verdict lanes settle on evidence instead of wedging**: lanes whose full
  transcript window carries a terminal message settle instead of failing
  `transcript_incomplete`; receipt-bearing lanes and idle empty-output
  lanes settle during collection; a stale/liveness verdict lane is
  superseded when a late valid transcript arrives (never for
  operator-cancelled lanes, discovery modes, or lanes cited by a persisted
  verdict-settlement receipt). Rejection errors now name the offending row
  first, with the full detail persisted as a lane artifact.
- **The lane-liveness watchdog is ON by default**: omitting the
  `lane_liveness_watchdog` configuration section now enables it (the
  30-minute deadline is unchanged). With the default config, a busy PR lane
  past the 30-minute deadline is now settled and its host session aborted
  (previously retained by the alive probe); opt out with
  `lane_liveness_watchdog.enabled: false` (the explicit opt-out path keeps
  working).
- **The architect prompt budget ceiling rises 164,000 → 165,000 chars**: the
  honest-INCOMPLETE completion guidance added here and the PR-feedback
  verification re-dispatch recovery that shipped in #3419 each fit under the
  old ceiling separately, but the merged prompt's feature-heavy cell measured
  164,188 — over by 188. The deliberate 1,000-char step keeps the #1649
  ratchet intact for unreviewed growth (docs/configuration.md updated).
