---
name: swarm-pr-review
description: >
  Codex adapter for deep PR review in opencode-swarm. Use when the user
  wants a broad, read-only PR review with low false-positive tolerance. The
  canonical protocol lives in .opencode and owns comment ingestion,
  CI/conflict/staleness intake, parallel explorer lanes, independent reviewer
  validation, critic challenge, and the explicit handoff into
  swarm-pr-feedback for approved fix work.
---

# Swarm PR Review

Read and follow `../../../.opencode/skills/swarm-pr-review/SKILL.md` as the
canonical workflow.

## Codex Execution Notes

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
  incremental `collect_lane_results` polling (without `wait`) to process
  settled lanes while continuing independent work; fall back to `wait: true`
  only when no independent work remains, and to blocking `dispatch_lanes`
  only when async collection is unavailable. All lanes must be settled
  before synthesis or phase transitions.
- If lane tools cannot close required coverage after retry/re-collection,
  Task-tool dispatch is the final fallback, but only as a verified equivalent:
  same agent type, same prompt, same scope, same isolation. If equivalence cannot
  be proven, stop and surface the lane failure as BLOCKED; do not produce a
  degraded review or partial verdict.
- When lane results include `output_ref`, call `retrieve_lane_output` for
  full text, then `parse_lane_candidates` to extract structured candidates
  for reviewer dispatch; degraded or incomplete outputs are coverage gaps.
- If actionable findings remain, write the handoff artifact described by the
  canonical skill and ask the user whether to continue with
  `swarm-pr-feedback`.

Do not improvise a fix path from review mode. If the user approves follow-up
work, switch to `swarm-pr-feedback` and carry validated findings forward with
their original IDs and provenance.

## Verdict row contract

The `[CRITIC]` row in the format above is **mandatory contract**, not advisory output. A critic response that does not end with that exact row format is treated as a planning preamble, not a verdict, and must be re-dispatched. Do not proceed past Phase 8 join barrier until each dispatched critic lane has produced a parseable `[CRITIC]` row.

**Re-dispatch trigger:** when a critic lane response is missing the verdict row, the orchestrator must automatically re-dispatch that lane with the explicit instruction: "Your final line MUST be exactly the Phase 8 contract row: `[CRITIC] | finding_id | UPHELD/DOWNGRADED/DISPROVED/NEEDS_MORE_EVIDENCE | final_severity | reason | required_report_change`. A response without that exact row will be treated as a planning message and re-dispatched." Do not synthesize findings from the planning preamble; only from the re-dispatched verdict.

**COVERAGE GATE alignment:** Critic lane failures follow the same COVERAGE GATE as explorer lanes: retry (max 2 attempts) with materially different parameters. If retries fail, deploy a verified equivalent alternative (same agent type, same prompt, same scope, same isolation), including Task-tool dispatch as the final fallback when lane tools do not work. If no equivalent can be verified, stop and surface the critic-lane failure to the user as BLOCKED — do NOT mark findings UNVERIFIED or continue past the gap. The orchestrator NEVER fabricates a critic verdict by parsing prose, by tolerating a planning preamble, by presenting partial findings, or by silently accepting reduced coverage.

Refuted findings become `DISPROVED` or `ADVISORY`, depending on critic rationale. Downgrades must be listed in the final validation provenance.
