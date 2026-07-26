# PR workflow lane output context management

Fixes compaction loops and re-dispatch cycles during `/swarm pr-review` and `/swarm pr-feedback` by protecting lane output from destruction and avoiding redundant full-text delivery on every poll.

## What changed

- **Lane results joined exempt list.** `dispatch_lanes`, `dispatch_lanes_async`,
  `collect_lane_results`, and `parse_lane_candidates` are now in a shared exempt
  list (`SUMMARIZER_EXEMPT_TOOL_NAMES` in `src/config/constants.ts`) honored
  by both the tool-output summarizer and the context-budget masker. Previously
  the summarizer replaced an over-threshold `collect_lane_results` payload with
  a ~1000-char type signature, destroying both the structured lane rows AND the
  `output_ref` values that are the documented recovery path — after which the
  workflow gate could not settle the lane and the model could not retrieve what
  was lost, so it re-dispatched in a loop. The exempt list is now a floor:
  operator config can add to it but cannot remove the correctness-critical
  entries. Three independently-hardcoded copies of this list are now one
  constant.

- **Lane output delivered once per settle, not on every poll.** `collect_lane_results`
  previously re-sent every completed lane's full preview on each incremental poll
  — up to ~160,000 characters per call for an 8-lane batch, repeated every poll.
  It now sends the inline preview on the first poll that observes a lane settled,
  and thereafter sends metadata plus `output_ref` with a new `output_omitted_repeat: true`
  marker. Full text stays retrievable via `retrieve_lane_output`.

- **Masked output names the right recovery tool.** Context-budget placeholders
  previously said "Use `retrieve_summary`" even for lane artifacts, which live in
  a different store; they now detect lane-output refs and point at `retrieve_lane_output`
  with the ref preserved.

- **`retrieve_summary` is reachable during PR workflows.** It previously had no
  PR-workflow capability tag, so the fail-closed gate blocked it — while
  summarized outputs kept telling the model to use it. Large observation outputs
  were unrecoverable mid-review.

- **Stage A payloads bounded in both directions.** `run_pr_feedback_stage_a`
  returned every executed check's full stdout and stderr (up to 64 KB each, up to
  258 checks) on BOTH success and failure. Full output is now persisted first and
  retrievable by reference; the response carries per-check summaries plus a bounded
  tail of the failing check only.

- **Argument-validation errors bounded.** `dispatch_lanes`, `dispatch_lanes_async`,
  and `collect_lane_results` now cap validation-error lists at 20 entries followed
  by `"... and N more"`, preventing uncapped error bloat from malformed payloads.

- **Freed-token accounting clamped non-negative.** Context-budget masking now
  clamps per-message freed-token deltas to zero, so a placeholder that ends up
  longer than the text it replaced can no longer incorrectly inflate the freed count.

- **Two read-only git commands admitted.** `git stash list` and `git worktree list`
  are now allowed during PR workflows. Mutating stash/worktree forms remain
  refused. This closes a real gap: the checkout-preparation tool hands back a
  `git stash apply --index <oid>` recovery instruction, but there was no allowed
  way to list stashes to find that OID.

- **Blocked-tool errors name the allowed surface.** The `PR_REVIEW` fail-closed
  rejection now lists the controller tools available in the active mode and
  points at `pr_workflow_status`, instead of only restating that the mode is
  read-only.

## Why

The PR workflow gate was not delivering the model usable output for large review
runs: lane output was destroyed by the summarizer, leaving the model no way to
recover it and forcing re-dispatch loops that bloomed context; Stage A check
output was sent in full on every poll, inflating token cost and context per
feedback run; tools that could recover lost output were blocked or
unreachable. The compaction loop was invisible to the user until the review
stalled or cost ballooned. Fail-closed behavior is unchanged — this is about
what the gate DELIVERS to the model, not what it permits.

## Migration

No migration required. The changes are transparent to existing lane-dispatch and
feedback workflows; lane output recovery now works without re-dispatch loops,
and Stage A responses stay bounded regardless of how many checks run, with
full output still preserved and retrievable by reference. Stage A does not run
faster — it now also persists a summary per run and awaits that write before
returning, which is a small added cost in exchange for bounded, recoverable
output.

## Related issues

Follow-up work tracked in #1967 (wake-cap/depth-tier tuning) and #1968 (gate
accounting redesign).
