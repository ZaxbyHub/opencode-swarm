---
name: swarm-ci-monitor
description: Codex adapter for end-to-end CI monitoring of an already-reviewed PR in opencode-swarm. Use when the user wants the swarm to monitor a reviewed-and-approved PR's CI, research every failure exhaustively, fix end-to-end, iterate until green (max 5 cycles), then merge. Composes ci-fix-monitor for fix recipes.
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
- **Pre-flight gate (do not merge unless all three hold; re-verify before every
  merge attempt, not just once):** `reviewDecision == APPROVED` AND
  `mergeable == MERGEABLE` AND `mergeStateStatus` in `{CLEAN, BEHIND}`. This is
  re-inlined here, not just referenced in the canonical, for the same reason as
  every other rule below: the merge gate must not depend on the canonical file
  loading successfully in this environment.
- **Merge is new surface area.** There is no `mcp__github__merge_pull_request`
  reference anywhere else in the repo. Verify availability via `ToolSearch`
  before first use in a session. Whichever path is used — MCP tool or the
  `gh pr merge <N>` bash fallback — **do not pass a merge-strategy
  parameter/flag** (no squash, no merge, no rebase method) and **never** an
  admin-bypass parameter/flag or `--delete-branch`: let branch protection
  determine the merge method, since this repo may or may not require a merge
  queue. On the bash fallback, `gh pr merge <N>` (no flags) either merges
  immediately, adds the PR to a required merge queue (poll
  `gh pr view <N> --json state,mergedAt,mergeCommit,mergeStateStatus` every
  1-2 minutes, up to 90 minutes, before escalating as a queue-timeout
  terminal), or errors (abort, do not retry blindly) — see the canonical's
  Step 4a for the full three-outcome handling; apply the same three-outcome
  model to whatever the MCP merge tool returns. Surface which path you took in
  the final report.
- **Post-merge confirmation must use local git**, not the GitHub API: after
  the merge returns (immediately or via queue), `git fetch origin <base>` and
  `git rev-parse origin/<base>`; the captured merge SHA must equal the base
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
- **Flaky-test quarantine is file-level only, and there are four quarantine
  files** — pick the one matching where the flake failed:
  `scripts/ci/quarantined-tests.txt` (unit+coverage, all OSes),
  `scripts/ci/quarantined-tests-macos.txt` / `-windows.txt` (unit+coverage,
  that OS only), `scripts/ci/quarantined-integration-tests.txt` (the
  `merge_group`-only integration step — never reads the base file). Each takes
  one repo-relative test file path per line. Never write a test name or a
  `test > case` string into it, and never retype a path — a syntactically
  valid but wrong path is silently ignored exactly like a malformed one. If
  the flake shares a file with non-flaky tests, fix it or `test.skip()` +
  escalate. Quarantining removes the file from the coverage-measured suite —
  check the coverage-gate threshold before and after.
- **Concurrency**: record local + remote head SHA before pushing; if the
  remote moved between fetch and push, abort the iteration, re-fetch, then
  **rebase your local working branch onto the new remote head** before
  retrying. **If this rebase halts with conflicts, `git rebase --abort` and
  escalate — never auto-resolve a conflicted rebase**; a bad resolution here
  would silently discard a collaborator's committed work before the
  force-push, and `--force-with-lease` does not protect against that.
  `--force-with-lease` only (rebase path); never `--force`. A race-abort does
  not consume a fix-cycle iteration. If a race-abort recurs 3× without
  progress, escalate as a concurrent-push terminal.
- Do not declare victory until the post-merge local-git confirmation (Step 4b)
  passes. Green checks alone are not sufficient.
- "`ToolSearch` didn't confirm the merge MCP tool but I'll try it anyway" → No.
  Fall back to the `gh pr merge` bash path instead of calling an unverified
  tool for the one action in this skill that cannot be safely undone.
