# PR review/feedback skills: cross-harness portability and depth-tiered dispatch

## What changed

- `swarm-pr-review` and `swarm-pr-feedback` now define three explicit runtime
  capability profiles, detected from the session's actual tool list: Profile A
  (OpenCode with the swarm plugin's mechanical PR-workflow controller),
  Profile B (harnesses with native fresh-context parallel subagents — Claude
  Code's `Agent`/`Task` tool and the native subagent mechanisms in OpenAI
  Codex and ZCode), and Profile C (sessions that genuinely lack any subagent
  mechanism; never assigned to a harness by name). Controller-only tools
  (`dispatch_lanes_async`, `collect_lane_results`, `retrieve_lane_output`,
  `parse_lane_candidates`, `write_pr_review_artifact`,
  `write_pr_review_trigger_eval`, `prepare_pr_workflow_checkout`,
  `prepare_pr_feedback_scope`, `run_pr_feedback_stage_a`,
  `complete_pr_workflow`, `abort_pr_workflow`) are now explicitly scoped to
  Profile A, and every phase carries a concrete native execution path for the
  other profiles. Controller absence is documented as a first-class state —
  never a BLOCKED dead end — while bypassing an ACTIVE controller remains
  BLOCKED exactly as before.
- **The PR-review controller itself now scales dispatch with a depth tier.**
  `bindPrReviewBase` computes S/M/L from the bound `base_sha...pr_head_sha`
  diff via a new bounded `git diff --numstat` helper
  (`resolvePrReviewDiffStats`; any failure fails strict to tier L) and
  persists the tier plus audit totals in the gate state. Base and micro
  discovery lanes accept a new optional `owned_workflow_lanes` field: at
  tiers S and M one lane may own several review dimensions or risk families
  (S: base wave ≥ 1 lane; M: ≥ 3; micro sweeps consolidated), while tier L
  preserves the historical exact-six singleton wave and one micro-lane per
  family byte-for-byte. All six dimensions and all eleven risk families
  remain mandatory to EVALUATE on every PR: ownership sets must partition
  the required sets exactly, every owned family needs its own
  `[CANDIDATE]`/`[CLEAN]` attestation, and a consolidated lane that fails
  any owned obligation fails them all. `write_pr_review_trigger_eval`
  accepts shared dispatch tuples only from lanes that declared exactly that
  ownership; reviewer/critic/feedback lanes reject `owned_workflow_lanes`
  outright. `parse_lane_candidates` gains `expected_micro_lanes` so
  per-family extraction from consolidated artifacts skips owned sibling
  families instead of refusing them. Singleton dispatches remain valid at
  every tier, so existing callers are unaffected.
- PR review guidance now anchors dispatch shape to the same explicit
  depth-tier model on every profile (S/M/L by changed lines/files, escalated
  caller-side by risk triggers such as auth, untrusted input, subprocesses,
  concurrency, dependencies, schema/migrations, PII, and generated
  artifacts).
- The `.claude` (Claude Code) and `.agents` (Codex/ZCode) adapters were
  rewritten from re-stated controller mandates into genuine per-harness
  execution notes: Claude Code gets a native Agent/Task Profile-B path with
  file-ledger persistence; Codex/ZCode default to Profile-B fresh-context
  subagent dispatch, with the sequential Profile-C path reserved (and
  disclosed) for sessions that genuinely lack subagents; controller tool
  names appear only inside "when this session actually exposes them"
  conditionals. The issue-tracer harness table's stale "not available
  in-session" subagent cells were corrected for Codex, ZCode, and the GitHub
  coding agent, in both the table and the install-reference rationale.
- `issue-tracer` was aligned with the same state of the art (v2.1.0):
  fresh-context subagent gates are the preferred path on every listed
  harness with fallback self-review purely condition-based; Phase 2 gains
  scaled parallel-explorer fan-out for broad localization surfaces; Phase 0
  gains an explicit depth-scaling rule tied to the shared risk-trigger
  vocabulary; the `.claude` agent definition and the GitHub Copilot
  `issue_tracer_2` agent now attempt delegation before self-review; and
  install.md documents the version-bump-on-edit rule the stamp system
  requires.
- Skill-content regression tests were updated to pin the new capability
  profiles, depth tiers, and adapter native paths, and new runtime tests
  cover tier computation, tier floors, consolidated ownership partitions,
  ownership-aware trigger-ledger acceptance, and per-family parsing.

## Why

The canonical skills hard-required OpenCode-plugin controller tools and
declared every alternative dispatch path "not equivalent — BLOCKED", which
left Claude Code, Codex, and ZCode sessions with no legal execution path, and
they mandated a 17-lane fan-out (6 base + 11 micro) even for trivial diffs —
on every harness, because the OpenCode controller enforced the fixed counts
mechanically. The rewrite aligns the skills with current agentic code-review
practice (review effort scaled to diff size and risk, mandatory verification
passes with exact file:line evidence, complementary rather than duplicated
lanes, graceful cross-harness degradation) and, per the owner's direction,
teaches the controller itself to compute and enforce the depth tier so scaled
dispatch is mechanical on OpenCode too — with the tier derived from the bound
diff, never from caller claims, preserving the anti-rationalization intent of
the original mechanical gates.

## Migration and compatibility

No schema-breaking changes: `owned_workflow_lanes`, `expected_micro_lanes`,
and the persisted `ownedWorkflowLanes`/`prReviewDepthTier`/`prReviewDiffStats`
fields are additive and optional; existing singleton dispatch flows validate
unchanged at every tier, and tier L reproduces the previous behavior exactly.
Callers that want consolidated dispatch opt in by declaring
`owned_workflow_lanes` on base/micro lanes when the controller-computed tier
is S or M. Repositories consuming the bundled skills on other harnesses now
get a real, attested execution path instead of an instructed dead end.
