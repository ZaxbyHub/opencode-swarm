# Issue 1746 Phase 2: CI improvements, Full-Auto oversight resilience, and PR monitoring enhancements

## New config keys (FR-003)

Added two new `full_auto.oversight` config keys with safe defaults:

- `full_auto.oversight.max_dispatch_retries` (default: `2`) — maximum retry attempts for a single oversight dispatch before treating it as a permanent failure.
- `full_auto.oversight.max_consecutive_dispatch_failures` (default: `3`) — consecutive infrastructure failures before the Full-Auto run auto-degrades to manual mode.

**Behavioral change:** When oversight dispatch fails 3 consecutive times, the run is now **auto-degraded to manual mode** (terminated) so an architect can re-enable manually. Previously, runs would stay paused indefinitely with no recovery path.

**Behavioral change:** The legacy reactive intercept path (`full-auto-intercept.ts`) now also retries transient errors (server errors, missing data) with exponential backoff before treating them as permanent failures. Previously, the first failure would crash through with `NEEDS_REVISION`.

## New `/swarm ci-simulate` command (FR-004a)

`/swarm ci-simulate` reproduces merge-group CI locally by:

1. Detecting the default remote branch (origin/main, origin/master, etc.)
2. Creating a temporary git worktree from that branch
3. Merging the PR branch (or current HEAD if no ref given) into the worktree
4. Running the full validation suite: `bun run typecheck`, `bun run lint`, `bun run build`, `bun test`
5. Reporting pass/fail per step with extracted file:line references
6. Cleaning up the temporary worktree

Usage:
```
/swarm ci-simulate              # uses current HEAD branch
/swarm ci-simulate <pr-ref>     # uses the specified branch/ref
```

**Purpose:** Catch integration failures (pass on PR branch, fail on merged result) before they cause merge-queue kick-outs.

## `/swarm pr status` merge_group extension (FR-004b)

`/swarm pr status` now surfaces GitHub merge group run status alongside PR-branch checks. Each subscribed PR shows:

- Merge group run status (queued / in_progress / completed)
- Conclusion if available (e.g., `success`, `failure`)
- HTML URL to the run

Example output line: `Merge group: completed success (https://github.com/owner/repo/actions/runs/123456)`

The merge group data is fetched via `gh run list --json` using the `statusCheckRollup` from the PR status as a filter.

## Batched CI failure notification (FR-005a)

When multiple CI checks fail in a single poll cycle, the pr-monitor worker now emits **ONE** batched `pr.ci.failed` event listing all failed checks, instead of N separate events per check.

The event payload shape:
```json
{
  "prNumber": 123,
  "repoFullName": "owner/repo",
  "prUrl": "https://github.com/owner/repo/pull/123",
  "failedChecks": [
    { "name": "typecheck", "conclusion": "failure" },
    { "name": "lint", "conclusion": "failure" }
  ]
}
```

The advisory formatter (`pr-event-subscribers.ts`) renders this as a single notification listing all failures, rather than flooding the session with N separate alerts.

## swarm-pr-feedback skill batching (FR-005b)

The `swarm-pr-feedback` skill now collects **ALL** failed check logs from a CI failure event in a single batch operation before beginning any fix work. This prevents the common failure mode where:

1. Bot posts check failure #1
2. Agent fixes #1
3. Bot re-runs CI
4. Bot posts check failure #2 (previously hidden behind #1's fix)
5. Agent is now working on stale context

With batching, all failures are gathered upfront so the root cause (often one fix addresses multiple failures) can be identified before any code is touched.
