# PR-review/PR-feedback: resolve Git off the blocking spawn on every bind/verify path

## What

Fixes `/swarm pr-review` and `/swarm pr-feedback` dispatch failing with
`BLOCKED: cannot resolve the current Git HEAD` on the long-running host. The
PR-workflow gate verified the checked-out HEAD, merge base, revision digest,
working-tree cleanliness, and upstream/publication state through synchronous,
event-loop-blocking `child_process.spawnSync` git calls. On the host process —
most acutely under Bun on Windows — a blocking spawn can hang to its bound
instead of returning, and the fail-closed gate then reports the misleading
"cannot resolve HEAD" block, aborting the entire dispatch.

The codebase already ships an event-loop-friendly async spawn helper
(`runGitAsync`) and had migrated the revision-digest and checkout-prep paths to
it. This change extends that migration to every remaining bind/verify/monitor
checkpoint:

- Ten new async resolver twins in `workspace-snapshot.ts` — HEAD
  (`resolveCurrentGitHeadAsync`), merge base (`resolveExactMergeBaseAsync`),
  working-tree cleanliness (`resolveIsWorkingTreeCleanAsync`), upstream
  push-target (`resolveCurrentUpstreamPushTargetAsync`), commit count since
  (`resolveCommitCountSinceAsync`), single-child-commit
  (`resolveIsExactSingleChildCommitAsync`), remote refs containing HEAD
  (`resolveRemoteRefsContainingHeadAsync`), exact remote branch head
  (`resolveExactRemoteBranchHeadAsync`), PR-review diff stats
  (`resolvePrReviewDiffStatsAsync`), and the Git control-state digest
  (`resolveGitControlStateDigestAsync`) — all reusing `runGitAsync`.
- `assertCurrentCheckoutHead`, `assertPrReviewCleanCheckout`, and
  `assertPrFeedbackTrackingCheckout` are now async and resolve Git through the
  twins; every call site awaits them.
- Coverage extends across `dispatch_lanes_async` (both `swarm-pr-review:` and
  `swarm-pr-feedback:` dispatch modes), PR-feedback publication arming,
  `completePrWorkflow`'s arming and post-publish remote verification,
  `enforcePrWorkflowToolBefore` (the read-only-shell short-circuit is
  preserved — the upstream resolver is still called only for non-empty shell
  commands), and the full `run_pr_feedback_stage_a` execution-monitor loop.

Fail-closed `null -> BLOCK` semantics and the issue-#1931 diagnostic messages
are preserved unchanged on every path.

Two regression guardrails ship in
`tests/unit/hooks/pr-workflow-gate-async-git-resolution.test.ts`:

- a behavioral tripwire that fails if a bind-path checkpoint reverts to the
  blocking sync spawn (mutation-verified to bite), and
- a source-scan tripwire that fails if any of the ten migrated resolvers is
  invoked in its bare synchronous form from any PR-workflow bind-path source
  file (`pr-workflow-gate.ts`, `dispatch-lanes.ts`,
  `run-pr-feedback-stage-a.ts`) — also mutation-verified to bite.

This supersedes the issue-#1931 fix, which only enriched the "cannot resolve
HEAD" error message ("...or the bounded Git invocation may have timed out")
without preventing the timeout that produces it.

## Why

The prior fix made the timeout legible but did not prevent it. Since the async
spawn helper already existed for the revision-digest path, the gap was that
the dispatch bind path and the PR-feedback publication/Stage-A monitor paths
never adopted it.

## Migration steps

None. This is an internal resolution-path change; no config, schema, tool, or
public API surface changed.

## Breaking changes

None.

## Known caveats

The blocking-spawn timeout this fixes is host-specific — it manifests under
Bun on Windows and could not be reproduced directly in this development
environment. The fix was validated structurally (typecheck, targeted test
batches, two independent adversarial implementation reviews, and two
mutation-verified regression guardrails); final confirmation that the reported
symptom no longer occurs should come from CI or a live `/swarm pr-review` run
on the previously affected host.
