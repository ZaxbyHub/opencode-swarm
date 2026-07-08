# Swarm CI monitor workflow

## What changed

- Added a `swarm-ci-monitor` skill (`.claude/skills/` canonical, no
  `.opencode` counterpart — same non-bundled, repo-internal-only class as
  `tech-debt-ci-review` and `qa-sweep`) that drives an already-reviewed,
  approved PR to a merged state: monitor CI, exhaustively research every
  failure, fix end-to-end, iterate until all required checks are green (max 5
  fix cycles), then merge — with no hardcoded merge strategy, so it works
  whether or not the base branch requires a GitHub merge queue.
- Added a Codex/GitHub-MCP adapter that delegates to the Claude canonical and
  translates the `gh` CLI surface to `mcp__github__*` tools, with a bash
  fallback for the merge step.
- The skill composes the existing `ci-fix-monitor` (failure classification +
  per-type fix recipes) and `commit-pr` (commit/push discipline) rather than
  re-deriving them.

## Why

The repo had skills to fix CI failures (`ci-fix-monitor`) and to watch a PR
after open (`swarm-pr-subscribe`), but no skill that owns the full
review-and-merge closeout: monitor → research → fix → iterate-until-green →
merge. Neither prior skill performs a merge at all — merging stayed a manual,
human-controlled step (the convention "publication by merge is a
user-controlled gate" appears elsewhere in the repo, e.g. `qa-sweep`).
`swarm-ci-monitor` is the first skill in the repo that performs a merge, so it
carries extra safety gates: a 5-iteration cap (mirrors `max_transient_retries`),
a concurrency guard with `--force-with-lease` only (including abort-on-conflict
for every rebase, not just auto-resolve), a pre-merge staleness re-check
against the current head SHA, and a post-merge confirmation that verifies the
merge commit via the **local git object DB** rather than the GitHub API (so it
does not share the check-status API's stale-fetch failure mode).

## Migration

No user migration required. The skill is invoked explicitly by name on a PR
the user has already reviewed and approved; nothing auto-invokes it.

## Known caveats

- **First merge primitive.** Invoke deliberately. The hard precondition
  (`reviewDecision: APPROVED`, `mergeStateStatus: CLEAN`/`BEHIND`) is enforced
  in Step 1, but the invoking user is the source of truth on whether review
  is actually complete.
- **"Required check" and the skipped-on-base rule are re-inlined** in the
  canonical Step 2a (rather than only inherited from `ci-fix-monitor`) so the
  merge gate does not depend on a generated file being regenerated unchanged.
  A check blocks merge only if it is required AND not green; a `skipped`
  required check is acceptable only if the same check was skipped on base.
- **Flaky-test quarantine is file-level only, and there are four quarantine
  files** (base + per-OS + a separate `merge_group`-only integration file),
  each read by a different CI job. The skill routes to the correct file by
  where the flake actually failed and will not jam a test name into any of
  them; intra-file flakes are fixed at the root or `test.skip()`-ed and
  escalated.
- **Pre-merge re-checks share the GitHub API transport.** They are
  defense-in-depth, not independent; the genuinely independent gate is the
  post-merge local-git confirmation (Step 4b of the skill).
- **Merge MCP tooling is new surface area.** There is no prior
  `mcp__github__merge_pull_request` reference in the repo. The adapter
  verifies availability via `ToolSearch` first and falls back to
  `gh pr merge` (no merge-strategy flag) via bash.
- **No hardcoded merge strategy.** The skill deliberately does not pass
  `--squash` (or any strategy flag) to `gh pr merge`, because a required
  GitHub merge queue accepts no strategy flag and enqueues instead of merging
  directly. The skill handles both the immediate-merge and queued-merge
  outcomes explicitly (see Step 4 in the canonical); it does not assume this
  repo's actual configuration.
