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
- If the repository defines a PR publication contract in local docs, templates,
  skills, or CI, ingest it as an obligation source. Do not assume this repo's
  title/body sections when the target repo does not define them.
- Treat every ingested signal as a claim until reviewer validation proves or
  disproves it with file:line evidence or explicit counter-evidence.
- Prefer GitHub connector tools when available, or `gh`, to inspect PR metadata,
  comments, review threads, checks, conflicts, and head SHA.
- Use the canonical deterministic lane flow: `dispatch_lanes_async` plus
  incremental `collect_lane_results` polling (without `wait`) to process
  settled lanes while continuing independent work; fall back to `wait: true`
  only when no independent work remains. All lanes must be settled before
  synthesis or phase transitions.
- If structured lane retries cannot close required coverage, stop and surface
  the lane failure as BLOCKED. Blocking and direct-Task dispatch are not
  equivalent because they cannot preserve the canonical skill's durable
  workflow-lane and exact-head provenance; do not produce a degraded review or
  partial verdict.
- When lane results include `output_ref`, call `retrieve_lane_output` for
  full text, then `parse_lane_candidates` to extract structured candidates
  for reviewer dispatch; degraded or incomplete outputs are coverage gaps.
- Clean lanes still require a fully populated row with evidence, such as
  `[CLEAN] | workflow_lane | coverage_scope | evidence` for a base lane or
  `[CLEAN] | micro_lane | coverage_scope | evidence` for a micro-lane.
- All 11 repository-agnostic micro-lanes in the canonical skill are mandatory;
  diff/path heuristics may focus prompts but cannot produce a `NO-MATCH` waiver.
- A newer reviewer batch invalidates all older critic evidence. Re-run the
  critic from the latest complete reviewer inventory before completion.
- Call `complete_pr_workflow` before the user-facing final response. While the
  durable gate remains active, architect response text is mechanically replaced
  and an idle parent session is resumed rather than allowed to stop early.
- If bind/checkout is genuinely unreachable, call `abort_pr_workflow` or run
  `/swarm abort-pr-workflow` (see canonical abort section; never a shortcut).
- If actionable findings remain, write the canonical handoff artifact and ask
  whether to continue with `swarm-pr-feedback`; do not improvise a fix path.
  Carry validated findings forward with their original IDs and provenance.
