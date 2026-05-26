---
name: commit-pr
description: >
  Codex-native adapter for the opencode-swarm publish workflow. Use when asked to
  commit, push, open or update a PR, refresh PR body text, mark a PR ready, or
  close out remote CI before merge.
---

# Commit & PR

Use this skill for Codex-side publication work in `opencode-swarm`.

## Source Of Truth

Read and follow [`../../../.claude/skills/commit-pr/SKILL.md`](../../../.claude/skills/commit-pr/SKILL.md) in full before committing, pushing, opening, or updating a PR.

That Claude skill remains the repository's canonical publish protocol. This Codex-native skill is the adapter layer: it tells Codex which tools to use, how to handle existing PRs, and how to finish the post-open lifecycle without drifting from the repo contract.

If instructions conflict:

1. `AGENTS.md`
2. `docs/engineering-invariants.md`
3. `../../../.claude/skills/commit-pr/SKILL.md`
4. this file

## Codex Execution Rules

- Use the available shell execution tool for `git`, `gh`, build, test, and CI commands.
- Use `apply_patch` for manual file edits.
- Use `multi_tool_use.parallel` for independent reads, status checks, and non-conflicting repo inspections.
- Do not stage `.Codex/`, IDE-local files, or unrelated worktree changes.
- Do not open a second PR when one already exists for the branch. Update the existing PR instead.

## Publish Modes

Infer the mode from the user request and branch state:

- `new-pr`: branch is ready to publish and no PR exists yet
- `pr-followup`: a PR already exists and you are addressing review feedback or syncing validation
- `closeout`: a PR already exists and you are updating body text, waiting on CI, marking ready, or confirming merge prerequisites

## Required Follow-Through

### Existing PR updates

If the branch already has a PR:

- inspect unresolved PR feedback surfaces before updating or readying the PR:
  review threads/comments, requested-changes reviews, CI/check failures,
  mergeability/conflicts, and whether check data belongs to the current head SHA
- update the existing PR body instead of creating a new PR
- refresh `## Summary`, `## Invariant audit`, and `## Test plan` when validation counts, caveats, or evidence changed
- verify the PR still points at the pushed branch head after any force-push
- use `$swarm-pr-feedback` when feedback needs fixes before closeout

### Draft vs ready

Default behavior:

- open or keep the PR as draft while follow-up edits are still expected, required checks are pending, or known caveats still need explanation
- mark the PR ready only after the body is current and required remote checks are green

If the user explicitly asks for a ready PR sooner, obey that request and document any remaining CI state clearly.

### Remote checks are authoritative

When the user asks to open, ship, ready, or close out a PR:

1. inspect remote checks with `gh pr view <n> --json statusCheckRollup,...` or `gh pr checks <n>`
2. verify check data belongs to the current `headRefOid` after every follow-up push
3. if a required job is `cancelled` and downstream jobs are `skipped`, inspect the run and rerun failed/cancelled jobs
4. if an obsolete older-head run is already failed or still consuming concurrency, inspect it before cancellation and cancel only when it is no longer the PR head under validation
5. wait for required checks to finish when practical
6. after conflict resolution, verify GitHub reports both `mergeable: MERGEABLE` and `mergeStateStatus: CLEAN`; local conflict-marker cleanup is not enough, and branch drift must appear in the closure ledger when it affected the PR
7. when `gh pr checks` looks stale, inspect the workflow run directly with `gh run view <run-id> --json headSha,status,conclusion,jobs,url`, and keep watching downstream integration/smoke jobs after unit jobs pass
8. if you edit the PR body after checks are green, expect PR Standards/title checks to rerun and re-check before calling the PR green
9. do not call the PR merge-ready while a required check is `cancelled`, `skipped`, `in_progress`, or otherwise non-green unless the user explicitly accepts that state

Recommended commands:

```powershell
gh pr view <number> --json body,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,state,statusCheckRollup,url
gh pr checks <number> --watch --fail-fast
gh run view <run-id> --json headSha,status,conclusion,jobs,url
gh run rerun <run-id> --failed
```

For CI `dist-check` failures on source-touching PRs, inspect the CI log first. If the failure is generated-output (`dist/`) drift from stale local dependencies, use the canonical executable recovery sequence in the source-of-truth skill, verify the `dist/` diff, and commit the regenerated files instead of calling the check pre-existing.

After a forced install on Windows, `EPERM` while reading refreshed `node_modules`
is usually host friction; rerun the exact focused command with approved access
before treating it as a code failure.

### Issue comment requirement

If the PR closes an issue:

- confirm the issue comment exists with the PR link, what changed, how to use it, and migration notes
- if the PR merged before the comment was posted, add the missing issue comment immediately

## Working Pattern

1. Read `AGENTS.md`, `docs/engineering-invariants.md` as needed, and the canonical Claude `commit-pr` skill.
2. Run the required local validation from the canonical skill.
3. Stage only intended files.
4. Create or update the PR.
5. Refresh PR body text if the branch changed after review feedback.
6. Watch remote checks to a useful conclusion when the user asked for publication or closeout.
7. Verify issue comments, ready/draft state, and merge-readiness claims before finishing.

## Clean-Main And CI Reality Checks

When local validation is noisy or host-limited:

- compare suspicious failures against a clean `origin/main` worktree before blaming the branch
- document proven pre-existing failures in the PR body
- use remote CI as the cross-platform source of truth for merge-readiness

## Final Sanity Check

- one branch, one PR
- PR head matches pushed `HEAD`
- PR body matches current validation evidence
- issue comment exists when the PR closes an issue
- draft or ready state matches user intent
- required remote checks are green, or any remaining non-green state is explicitly explained
