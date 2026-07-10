# Issue #1746 — Worktree Cleanup, Skill Assertions, CI Improvements, and Diff-Aware PR Gating (Complete)

## Project Summary

Issue #1746 resolved four clusters of P0 friction points from long-running swarm sessions: unconditional worktree cleanup on every coder dispatch, skill-content pre-push assertion checks, CI resilience and merge-group visibility, and diff-aware PR placeholder gating with per-task reviewer/test_engineer attribution.

---

## What Changed (Full Scope)

### Phase 1 — Worktree Cleanup and Skill-Assertion Pre-Push Check

**FR-001 — Unconditional worktree cleanup on every coder dispatch outcome**

Every coder dispatch now cleans up after itself — success, denial, or cancellation. No worktree directory, lane branch, or in-memory tracking entry is left behind.

- **FR-001a**: On success, denial, or cancellation, the worktree, lane branch, and in-memory tracking are removed. A retry no longer collides with a prior run's leftover artifacts.
- **FR-001b**: Before dispatching a coder, the system checks whether a lane is already provisioned for this session and cleans it up first. Lanes belonging to other active sessions are never touched (ownership validated by session ID).
- **FR-001c**: When a dispatch is denied or cancelled and the worktree has uncommitted work, the system auto-commits changes and tags the commit with `swarm-collision-recovery/` before cleaning up. If the git operation fails, cleanup aborts entirely to protect the work — fail-closed.

**FR-002 — Skill-content pre-push check**

When a contributor edits a skill file or architect prompt, a pre-push check flags any existing test that asserts exact wording from that file and would break with the new content. Integrated into the existing `scripts/drift-check.ts` CI workflow. Results available locally in under 5 seconds for a typical single-file diff.

**Key constraints**: FR-001c uses fail-closed preservation; FR-001b detects stale lanes before re-provisioning and preserves cross-session lanes via session-ID ownership validation; FR-002 extends the existing drift-check.ts workflow rather than introducing a new CI step.

---

### Phase 2 — CI Improvements, Full-Auto Oversight Resilience, and PR Monitoring

**FR-003 — Full-Auto oversight resilience**

Added two new `full_auto.oversight` config keys with safe defaults:

- `full_auto.oversight.max_dispatch_retries` (default: `2`) — maximum retry attempts for a single oversight dispatch before treating it as a permanent failure.
- `full_auto.oversight.max_consecutive_dispatch_failures` (default: `3`) — consecutive infrastructure failures before the Full-Auto run auto-degrades to manual mode.

When oversight dispatch fails 3 consecutive times, the run auto-degrades to manual mode so an architect can re-enable manually. Previously, runs stayed paused indefinitely with no recovery path.

The legacy reactive intercept path (`full-auto-intercept.ts`) now also retries transient errors (server errors, missing data) with exponential backoff before treating them as permanent failures.

**FR-004a — `/swarm ci-simulate` command**

Reproduces merge-group CI locally by: detecting the default remote branch, creating a temporary git worktree from that branch, merging the PR branch (or current HEAD) into the worktree, running the full validation suite (`bun run typecheck`, `bun run lint`, `bun run build`, `bun test`), reporting pass/fail per step with extracted file:line references, and cleaning up the temporary worktree.

**FR-004b — `/swarm pr status` merge_group extension**

Surfaces GitHub merge group run status (queued / in_progress / completed) alongside PR-branch checks. Merge group data is fetched via `gh run list --json` using the `statusCheckRollup` from the PR status as a filter.

**FR-005a — Batched CI failure notification**

When multiple CI checks fail in a single poll cycle, the pr-monitor worker emits ONE batched `pr.ci.failed` event listing all failed checks, instead of N separate events per check. The event includes `{ name, conclusion }` per check.

**FR-005b — swarm-pr-feedback skill batching**

The `swarm-pr-feedback` skill now collects ALL failed check logs from a CI failure event in a single batch operation before beginning any fix work, preventing the common failure mode where fixing check #1 reveals a previously-hidden check #2 to a now-stale agent.

---

### Phase 3 — Diff-Aware Placeholder Scan + Set-Dispatch Attribution

**FR-006 — Diff-Aware Placeholder Scan**

The `placeholder_scan` tool now accepts an `added_lines` parameter that restricts findings to lines added in the PR. Pre-existing placeholders on unchanged lines no longer gate PRs. Also supports `sentinel_allowlist` for substring-match suppression of intentional sentinel markers like `SC-PLACEHOLDER`.

**FR-007 — Set-Dispatch Per-Task Attribution**

Reviewer and test_engineer agents now emit structured per-task verdict lines when covering multiple tasks in a single dispatch. The delegation gate parses these verdicts (`[REVIEWED] | task-<id> | APPROVED |`, `[TESTED] | task-<id> | PASS |`, etc.) and attributes each task independently, preventing over- or under-attribution in high-throughput workflows.

---

## Files Changed

| File | Phase |
|------|-------|
| `src/hooks/delegation-gate/worktree-isolation.ts` | 1 |
| `src/hooks/delegation-gate.ts` | 1 |
| `scripts/check-skill-assertions.ts` | 1 |
| `scripts/drift-check.ts` (skill-assertion extension) | 1 |
| `src/config/schema.ts` (FR-003 config keys) | 2 |
| `src/full-auto/oversight.ts` (dispatch retry / auto-degrade) | 2 |
| `src/hooks/full-auto-intercept.ts` (exponential backoff) | 2 |
| `src/commands/ci-simulate.ts` (FR-004a) | 2 |
| `src/commands/pr-monitor-status.ts` (merge_group extension) | 2 |
| `src/background/pr-event-subscribers.ts` (batched events) | 2 |
| `.opencode/skills/swarm-pr-feedback/SKILL.md` (batching) | 2 |
| `src/tools/placeholder-scan.ts` (FR-006 added_lines + sentinel_allowlist) | 3 |
| `src/agents/reviewer.ts` (structured verdict output) | 3 |
| `src/agents/test-engineer.ts` (structured verdict output) | 3 |
| `src/hooks/delegation-gate.ts` (parsePerTaskVerdicts + per-task attribution) | 3 |

## Testing

- **Phase 1**: Worktree cleanup coverage for success/denial/cancellation paths; session-ownership collision detection; fail-closed git auto-commit on dirty state
- **Phase 2**: Config key defaults and behavior; ci-simulate worktree lifecycle; merge_group status parsing; batched event emission
- **Phase 3**: 6 tests for diff-aware placeholder filtering; 10+ tests for verdict parsing, multi-task attribution, and fallback behavior

All phases completed and validated. No migration required for existing deployments.
