---
name: ci-failure-batching
audience: swarm-plugin
description: Batch collection and fix protocol for CI failures. Triggered when any CI check fails on a PR. Prevents serial diagnose-fix-push cycles by collecting all failures before fixing.
---

# CI Failure Batching

## Trigger
When the PR monitor surfaces `pr.ci.failed`. The event is batched after the
check set is complete and includes all known failed checks in `failedChecks`.

## Protocol
1. **DO NOT immediately fix the first failure.** Check if other jobs are still running:
   ```
   gh pr checks <PR> --repo <repo>
   ```
2. **If jobs are still running:** Note the failure, WAIT for the run to complete
3. **Once the run completes, collect ALL failures:**
   - Identify every check with `fail` status
   - For each: `gh run view <run-id> --log-failed`
   - Build a complete failure ledger
4. **Fix ALL failures in one changeset:** Cluster by root cause, fix each cluster, verify locally
5. **Push the fixes in one cycle.** Amend the commit and push. NOTE: `git push --force` / `--force-with-lease` is deny-pattern-blocked by the guardrail in guarded sessions (no orchestrator exemption). If force-push is blocked, push a normal new fix commit instead — the batching goal is ONE push cycle (collect all → fix all → push once), not literally one commit. A single new commit containing all batched fixes satisfies the goal.
6. **Only re-push if NEW failures surface** that were not in the original batch.

## Why this matters
Without batching, N failures produce N push cycles. With batching, N failures produce 1 push cycle.

Example from session #1685:
- Without batching: 6 pushes (format → stale-assertion-1 → stale-assertion-2 → integration → merge-group → clean)
- With batching: 2 pushes (collect all → fix all → push once → clean)

## Pr-monitor expectation
The pr-monitor should fire one `pr.ci.failed` event for the completed failing
check set, not one event per check. Still verify with `gh pr checks` before
fixing, because GitHub can append late merge-group or matrix jobs.
