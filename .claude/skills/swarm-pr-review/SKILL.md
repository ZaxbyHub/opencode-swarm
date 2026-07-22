---
name: swarm-pr-review
audience: swarm-plugin
description: >
  Use when asked to review a pull request, PR URL, or PR #N with a broad,
  read-only review and low false-positive tolerance. This Claude Code adapter's
  canonical protocol lives in .opencode and owns comment ingestion,
  CI/conflict/staleness intake, parallel explorer lanes, independent reviewer
  validation, critic challenge, and the explicit handoff into
  swarm-pr-feedback for approved fix work.
---

# Swarm PR Review
Read and follow `../../../.opencode/skills/swarm-pr-review/SKILL.md` as the canonical workflow.
## Claude Code Execution Notes
- A plain Claude Code session has none of the swarm plugin's controller tools:
  that is canonical Profile B, not an error. Never report BLOCKED merely
  because controller tools are absent — dispatch the review through the
  `Agent`/`Task` subagent tool, following the canonical phases, role
  boundaries, row contracts, and join barriers.
- `PR_REVIEW` is read-only with respect to the PR branch: fetch refs, inspect
  metadata, and check out the PR head after verifying a clean working tree,
  but do not fix code, resolve conflicts, commit, push, rebase, or reset.
- Before dispatching explorer lanes, fetch the PR head and verify `git cat-file -e
  <full_pr_head_sha>^{commit}`; run `git switch --detach <full_pr_head_sha>`, confirm and bind that exact HEAD. Do not use `--track FETCH_HEAD`.
- Ingest every review signal before explorer lanes: PR comments, review
  summaries, requested changes, bot findings, CI/check failures,
  mergeability/conflicts, stale branch/base drift, PR body claims, linked
  issues, and commit messages — each a claim until reviewer validation proves
  or disproves it with file:line evidence.
- If the repository defines a PR publication contract in local docs, templates,
  skills, or CI, ingest it as an obligation source; do not assume this repo's
  title/body sections elsewhere.
- Prefer GitHub connector/MCP tools when available, or `gh`, to inspect PR
  metadata, comments, review threads, checks, conflicts, and head SHA.
- Profile B accounting: classify the depth tier (S/M/L); cover all six base
  dimensions and evaluate all 11 risk families with lane counts scaled per the
  canonical depth-tier table; stamp every subagent prompt and ledger row with
  its workflow-lane id and exact-head provenance (the bound `pr_head_sha`);
  persist findings and trigger ledgers as files in the session task workspace,
  never under `.swarm/`.
- Clean lanes still require a fully populated row, such as
  `[CLEAN] | workflow_lane | coverage_scope | evidence`; a missing per-family
  attestation is an unclosed coverage gap — retry it or surface it as BLOCKED
  rather than emitting a degraded review or partial verdict.
- Use fresh reviewer subagents for candidate validation and fresh critic
  subagents after review; a newer reviewer batch invalidates older critic
  evidence. The Pre-Synthesis Gate checklist is the completion gate.
- Only if this session actually exposes the swarm controller tools
  (`dispatch_lanes_async`, `collect_lane_results`, `retrieve_lane_output`),
  run Profile A instead: structured modes, incremental polling, full-text
  retrieval for every `output_ref`, and `complete_pr_workflow` before the
  final response. While that controller is active, blocking dispatch and
  direct-Task dispatch are not equivalent — never bypass it.
- If actionable findings remain, write the canonical handoff artifact and ask
  whether to continue with `swarm-pr-feedback`; carry validated findings
  forward with their original IDs and provenance.
