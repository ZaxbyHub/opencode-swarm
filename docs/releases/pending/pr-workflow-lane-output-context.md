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
  258 checks) on BOTH success and failure. Both responses now carry per-check
  summaries (category, command, exit code, duration) instead of inline output.
  On failure, the full output is persisted first and the response adds a bounded
  tail of the failing check plus a `full_output_ref` for retrieval via
  `retrieve_summary`; if that write fails, the failing check's complete
  stdout/stderr is inlined instead so evidence is never lost. A successful run
  persists nothing and returns no reference — there is no failure evidence to
  recover, and `.swarm/summaries/` has no directory-level eviction, so writing
  passing build and lint output on every feedback iteration would grow it
  without bound.

- **Argument-validation errors bounded.** `dispatch_lanes`, `dispatch_lanes_async`,
  and `collect_lane_results` now cap validation-error lists at 20 entries followed
  by `"... and N more"`, preventing uncapped error bloat from malformed payloads.

- **Freed-token accounting clamped non-negative.** Context-budget masking now
  clamps per-message freed-token deltas to zero. Previously a placeholder longer
  than the text it replaced produced a negative delta, and because the caller
  subtracts the freed total from the running count, that negative silently
  *increased* the tracked context usage.

- **Two read-only git commands admitted.** `git stash list` and `git worktree list`
  are now allowed during PR workflows. Mutating stash/worktree forms remain
  refused. This closes a real gap: the checkout-preparation tool hands back a
  `git stash apply --index <oid>` recovery instruction, but there was no allowed
  way to list stashes to find that OID.

- **`git -c` config-injection bypass closed, in both classifiers.** The `-C`
  directory-override match was case-insensitive, so lowercase `-c` — git's
  arbitrary per-invocation config flag, e.g. `-c core.pager=touch` — also
  satisfied it. `git -c core.pager=touch status` was captured as bare `status`
  and admitted, silently stripping the injected config from what the classifier
  evaluated. Both patterns are now case-sensitive on `-C` (only the leading
  `git` keyword itself stays case-insensitive), so `-c ...` falls through to the
  fail-closed reject.

  This applies to the standalone-commit classifier as well as the read-only
  intake one. That second half is the more dangerous of the two: it guards a
  *mutating* verb, so `git -c core.hooksPath=/tmp/evil commit -m x` previously
  classified identically to a bare `git commit -m x` and would have executed
  attacker-chosen hooks at commit time once a feedback run legitimately reached
  its publication state.

- **Blocked-tool errors name the allowed surface.** Both the `PR_REVIEW` and
  `PR_FEEDBACK` fail-closed rejections now list the controller tools available in
  the active mode and point at `pr_workflow_status`, instead of only restating
  that the mode is read-only. The blocked-shell diagnosis also now names
  `stash list` and `worktree list` among the allowed git reads.

## Why

The PR workflow gate was not delivering the model usable output for large review
runs: lane output was destroyed by the summarizer, leaving the model no way to
recover it and forcing re-dispatch loops that bloomed context; Stage A check
output was sent in full on every poll, inflating token cost and context per
feedback run; tools that could recover lost output were blocked or
unreachable. The compaction loop was invisible to the user until the review
stalled or cost ballooned.

Most of this change is about what the gate DELIVERS to the model rather than
what it permits. The permitted surface does move, in four narrow and
individually documented ways: `git stash list` and `git worktree list` are newly
admitted; `retrieve_summary` is newly admitted; the `-c` config-injection forms
are newly refused, in both the read-intake and standalone-commit classifiers;
and `get_async_result` / `get_async_status` were dropped from the controller
allowlist. That last one is a narrowing with no practical effect — neither name
was ever a registered tool, so nothing could call them either way — but the set
is the live admission classifier and not merely display text, so it is listed
here rather than treated as cosmetic. Nothing else moved.

## Migration

One operator-visible behavior change, otherwise no migration required.

If you set `tool_output.truncation_tools` explicitly, the floor is now
subtracted from your configured list as well as from the default. A list
composed only of floor members (`read` and `task` are both on it) therefore
resolves to an empty effective set and line-truncation is off, where it
previously applied. The floor exists so operator config cannot reintroduce the
unrecoverable-payload defect by re-enabling rewriting of the ref-carrying lane
tools; it is applied uniformly rather than per-tool, so `read` and `task` are
subtracted too even though they carry no refs. Audit the setting if you rely on
it; drop floor members from the list to make the effective set explicit.

Otherwise the changes are transparent to existing lane-dispatch and
feedback workflows; lane output recovery now works without re-dispatch loops,
and Stage A responses stay bounded regardless of how many checks run. Stage A is
not made faster by this change: a failing run now persists the full output and
awaits that write before returning, a small added cost in exchange for bounded,
recoverable evidence. A successful run performs no such write.

## Related issues

Follow-up work tracked in #1967 (wake-cap/depth-tier tuning) and #1968 (gate
accounting redesign).
