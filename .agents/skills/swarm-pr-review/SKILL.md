---
name: swarm-pr-review
audience: swarm-plugin
description: >
  Use when asked to review a pull request, PR URL, or PR #N with a broad,
  read-only review and low false-positive tolerance. This Codex adapter's
  canonical protocol lives in .opencode and owns comment ingestion,
  CI/conflict/staleness intake, parallel explorer lanes, independent reviewer
  validation, critic challenge, and the explicit handoff into
  swarm-pr-feedback for approved fix work.
---
# Swarm PR Review
Read and follow `../../../.opencode/skills/swarm-pr-review/SKILL.md` as the canonical workflow.
## Codex Execution Notes
- Codex and ZCode sessions normally have no swarm controller tools: that is
  canonical Profile B, not an error — both runtimes can spawn fresh-context
  subagents. Never report BLOCKED merely because those tools are absent —
  dispatch the canonical lanes through the runtime's parallel-execution capability
  as independent fresh-context subagents, honoring the canonical phases, role
  boundaries, row contracts, and join barriers. Use Profile C strictly
  separated sequential role passes (candidates → reviewer → critic) only when
  the session genuinely lacks a subagent mechanism, and disclose that
  procedural independence in the provenance.
- `PR_REVIEW` is read-only with respect to the PR branch: fetch refs, inspect metadata,
  check out its head after verifying a clean tree; do not fix, commit, push, rebase, or reset.
- Before dispatching explorer lanes, fetch the PR head and verify it with
  `git rev-parse --verify <full_pr_head_sha>^0` and `git cat-file -t <full_pr_head_sha>` (must print `commit`);
  run `git switch --detach <full_pr_head_sha>`, bind that exact HEAD, and do not use `--track FETCH_HEAD`.
- Ingest every review signal before explorer lanes: PR comments, review
  summaries, requested changes, bot findings, CI/check failures,
  mergeability/conflicts, stale branch/base drift, PR body claims, linked
  issues, and commit messages — each a claim until reviewer validation proves
  or disproves it with file:line evidence.
- If the repository defines a PR publication contract in local docs,
  templates, skills, or CI, ingest it as an obligation source.
- Accounting on Profiles B/C: classify the depth tier (S/M/L); cover all six
  base dimensions and evaluate all 11 risk families with lane or pass counts
  scaled per the canonical depth-tier table; stamp every lane prompt or pass
  record with its workflow-lane id and exact-head provenance (the bound
  `pr_head_sha`); persist findings and trigger ledgers in working notes,
  never under `.swarm/`.
- Clean lanes still require a fully populated row: base lanes use
  `[CLEAN] | lane | coverage_scope | evidence`; micro and council lanes use
  `[CLEAN] | micro_lane | coverage_scope | evidence`. A missing attestation is
  a coverage gap — retry it or surface BLOCKED, never a degraded review.
- When a lane result includes an `output_ref`, retrieve the full text before
  extracting candidates; degraded or truncated output is a coverage gap.
- Reviewer and critic verdicts compose per item across passes: a reviewer retry
  invalidates only the critic evidence for items whose reviewer row changed;
  re-run the critic for items left without a critic verdict before completion.
- Where the swarm plugin's structured controller is active (OpenCode hosts),
  the controller computes the depth tier from the bound diff. With the default
  `pr_review_resilience` policy enabled, Profile A must stage depth-tier M/L
  base attempts as a singleton canary batch followed by a fanout batch
  (`pr_review_wave_stage` / `pr_review_wave_attempt`), carrying forward only
  unresolved obligations; typed `retry_exhausted` and `circuit_open` outcomes
  are hard blockers, not prompts to degrade the review. Tier S keeps the legacy
  single consolidated `owned_workflow_lanes`-partitioned batch because staged
  resilience does not apply there. If that policy is disabled, Profile A falls
  back to the legacy non-staged base wave: tier L may dispatch one structured
  exact-six batch with workflow-lane and exact-head provenance, while tiers S/M
  use a smaller consolidated batch whose `owned_workflow_lanes` still partition
  all six dimensions. While it is active a different dispatch path is not
  equivalent — never bypass the controller.
- If actionable findings remain, write the canonical handoff and ask to continue with `/swarm pr-feedback <PR_URL> continue from .swarm/pr-review/<run_id>/feedback-handoff.json`.
  On Profile A this is a mechanical transition; preserve finding IDs and provenance.
