---
name: swarm-pr-review
description: >
  Claude Code adapter for deep PR review in opencode-swarm. Use when the user
  wants a broad, read-only PR review with low false-positive tolerance. The
  canonical protocol lives in .opencode and owns comment ingestion,
  CI/conflict/staleness intake, parallel explorer lanes, independent reviewer
  validation, critic challenge, and the explicit handoff into
  swarm-pr-feedback for approved fix work.
---

# Swarm PR Review

Read and follow `../../../.opencode/skills/swarm-pr-review/SKILL.md` as the
canonical workflow.

## Claude Code Execution Notes

- `PR_REVIEW` is read-only with respect to the PR branch. You may fetch refs,
  inspect metadata, and check out the PR head after verifying a clean working
  tree, but do not fix code, resolve conflicts, commit, push, rebase, or reset
  from this mode.
- Ingest every review signal before explorer lanes: PR comments,
  review summaries, requested changes, bot findings, CI/check failures,
  mergeability/conflicts, stale branch/base drift, PR body claims, linked
  issues, and commit messages.
- Treat every ingested signal as a claim until reviewer validation proves or
  disproves it with file:line evidence or explicit counter-evidence.
- Prefer GitHub connector tools when available, or `gh`, to inspect PR metadata,
  comments, review threads, checks, conflicts, and head SHA.
- Use the canonical deterministic lane flow: `dispatch_lanes_async` plus
  `collect_lane_results`, falling back to blocking `dispatch_lanes` only when
  async collection is unavailable.
- When lane results include `output_ref`, call `parse_lane_candidates` and use
  the structured candidates for reviewer dispatch; degraded or incomplete
  outputs are coverage gaps.
- If actionable findings remain, write the handoff artifact described by the
  canonical skill and ask the user whether to continue with
  `swarm-pr-feedback`.

Do not improvise a fix path from review mode. If the user approves follow-up
work, switch to `swarm-pr-feedback` and carry validated findings forward with
their original IDs and provenance.
