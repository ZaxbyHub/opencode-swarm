- Canonicalized `swarm-pr-review` around the `.opencode` protocol and tightened
  the mirror contract so the review adapters point back to the canonical skill
  instead of carrying a second operative workflow.
- Expanded PR review intake so existing review comments, requested changes, bot
  findings, CI/check failures, mergeability/conflicts, stale branch state, PR
  body claims, linked issues, and commit messages are part of the initial review
  ledger before the explorer lanes run.
- Added an explicit PR review handoff artifact under `.swarm/pr-review/<run_id>/`
  and a stop-and-ask transition into `swarm-pr-feedback` instead of letting
  review mode drift into fix work.
- Updated `swarm-pr-feedback` to ingest validated review handoff artifacts,
  preserve original IDs/provenance, and require explicit user approval before
  acting on review-discovered findings.
- Documented the brainstorm `auto_proceed` option in the mirrored skill text.
