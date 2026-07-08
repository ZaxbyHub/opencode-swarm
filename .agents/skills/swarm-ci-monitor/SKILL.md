---
name: swarm-ci-monitor
description: Codex adapter for end-to-end CI monitoring of an already-reviewed PR in opencode-swarm. Use when the user wants the swarm to monitor a reviewed-and-approved PR's CI, research every failure exhaustively, fix end-to-end, iterate until green (max 5 cycles), then merge via squash. Composes ci-fix-monitor for fix recipes.
---

# Swarm CI Monitor

Read `../../../.claude/skills/swarm-ci-monitor/SKILL.md` for the full protocol.

Also load:

1. `../../../.opencode/skills/generated/ci-fix-monitor/SKILL.md` for failure
   classification and per-type fix recipes.
2. `../commit-pr/SKILL.md` before committing or pushing any fix.

Codex-specific execution notes:

- No `gh` CLI in the remote/MCP environment. Use MCP tools instead:
  - PR checks → `mcp__github__pull_request_read` method `get_check_runs`
  - Failure logs → `mcp__github__get_job_logs` with `job_id`, `return_content: true`
  - PR mergeable/mergeStateStatus/reviewDecision → `mcp__github__pull_request_read` method `get`
- **Merge is new surface area.** There is no `mcp__github__merge_pull_request`
  reference anywhere else in the repo. Verify availability via `ToolSearch`
  before first use in a session. If a merge MCP tool is unavailable, fall back
  to `gh pr merge <N> --squash` via the bash tool — squash only, never
  `--merge`/`--rebase`, never `--delete-branch`. Surface which path you took
  in the final report.
- **Post-merge confirmation must use local git**, not the GitHub API: after
  `gh pr merge`/MCP merge returns, `git fetch origin <base>` and
  `git rev-parse origin/<base>`; the captured squash SHA must equal the base
  tip. The GitHub API can lag; the local object DB cannot. If the base tip
  does not match after the merge returned success, re-fetch at most 2 more
  times (~1 min apart); if still mismatched, escalate as a post-merge
  mismatch terminal — do NOT issue a second merge.
- **Iteration cap is 5.** After 5 failed fix cycles on the same PR, stop and
  escalate — do not keep pushing. This mirrors the repo's `max_transient_retries`
  default (AGENTS.md invariant #9) and resets per invocation.
- **"Required check" is defined operationally** (re-inlined in the canonical
  Step 2a so this merge gate does not depend on ci-fix-monitor's generated
  file): a check blocks merge only if it is **required AND not green**, per
  `gh pr checks`/MCP `get_check_runs` required flag and the branch-protection
  rule. A `skipped` required check is acceptable ONLY if the same check was
  skipped on the base branch (path-filter gate) — otherwise treat as
  non-green. `neutral`/`action_required` required checks are non-green.
- **Flaky-test quarantine is file-level only.** The repo's quarantine file
  (`scripts/ci/quarantined-tests.txt`) takes one repo-relative test file path
  per line. Never write a test name or a `test > case` string into it — those
  lines are silently ignored and the flake is hidden, not handled. If the
  flake shares a file with non-flaky tests, fix it or `test.skip()` + escalate.
- **Concurrency**: record local + remote head SHA before pushing; if the
  remote moved between fetch and push, abort the iteration, re-fetch, then
  **rebase your local working branch onto the new remote head** before
  retrying. `--force-with-lease` only (rebase path); never `--force`. If a
  race-abort recurs 3× without progress, escalate as a concurrent-push
  terminal.
- Do not declare victory until the post-merge local-git confirmation (Step 4b)
  passes. Green checks alone are not sufficient.
