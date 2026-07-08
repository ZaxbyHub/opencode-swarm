---
name: swarm-ci-monitor
description: >
  End-to-end CI monitor that takes an already-human-reviewed PR, exhaustively
  researches every CI failure, fixes it end-to-end, iterates until all required
  checks are green (max 5 fix cycles), then merges via squash. Use only after
  human review is complete and the PR is approved. Composes ci-fix-monitor for
  failure-type-specific fix recipes. This is the first skill in the repo that
  executes a merge — invoke it deliberately.
---

# Swarm CI Monitor

Drives a reviewed-and-approved PR to a merged state by monitoring its CI,
exhaustively researching every failure, fixing it end-to-end, and iterating
until all required checks are green — then merging via squash.

This is **not** a fresh review skill and **not** a PR-creation skill. It is the
terminal closeout hop for a PR that is already approved and just needs to get
green and merge. It is the first skill in opencode-swarm that performs a merge,
so it carries extra safety gates.

## Hard precondition

Human review is already complete. Do not run this skill on a PR that has not
been reviewed and approved. The pre-flight gates below enforce this, but the
invoking user is the source of truth: only invoke after review is done.

## Composition

Load these skills before doing anything destructive (push / merge):

- `../../../.opencode/skills/generated/ci-fix-monitor/SKILL.md` — for failure
  classification and the per-type fix recipes (package-check, rebase,
  format/lint, macOS file I/O, integration, security, smoke). Do not re-derive
  these recipes here; ci-fix-monitor owns them.
- `../commit-pr/SKILL.md` — before any push, for the commit/push discipline.

The "do not declare victory until ALL required checks pass" rule is inherited
from ci-fix-monitor. The "skipped only if skipped on base" rule is **re-inlined
in Step 2a below** because this skill owns a merge gate and must not depend on
ci-fix-monitor's generated file being regenerated unchanged.

## Environment note — tool availability

The canonical uses the `gh` CLI. In remote/MCP environments, use the equivalent
MCP tools and verify availability first:

| `gh` CLI | Remote MCP equivalent |
|---|---|
| `gh pr checks <N>` | `mcp__github__pull_request_read` method `get_check_runs` |
| `gh pr view <N> --json mergeable,mergeStateStatus,reviewDecision` | `mcp__github__pull_request_read` method `get` |
| `gh run view <run> --log` | `mcp__github__get_job_logs` with `job_id`, `return_content: true` |

> MCP tool names are injected by the harness and not stable across
> environments. Use `ToolSearch` to verify before first use in a session.

## Step 1 — Pre-flight gates (run ONCE, before entering the loop)

Abort and report if any gate fails. Do not auto-fix pre-flight failures — they
mean the skill should not have been invoked yet.

1. **User named the PR explicitly.** No auto-discovery. If the user did not
   name a PR, ask.
2. **`reviewDecision: APPROVED`.** Every required reviewer approved. If not →
   abort with "human review not complete." This skill does not negotiate
   reviews.
3. **`mergeable: MERGEABLE`** and **`mergeStateStatus`** is `CLEAN` or `BEHIND`.
   - `BEHIND` → rebase onto main via ci-fix-monitor's rebase recipe
     (`git fetch origin main && git rebase origin/main`, abort+escalate on
     conflict, `git push --force-with-lease`). Then re-run this gate.
   - `BLOCKED`, `DIRTY`, `HAS_HOOKS_FAILURE`, or any other state → abort and
     report the exact `mergeStateStatus`.

Only after all three gates pass, enter the loop.

## Step 2 — The monitor → fix loop (max 5 iterations)

Maintain an iteration counter starting at 5. Each fix-push cycle decrements it.
At 0, stop (Step 5).

### 2a. Fetch check runs for the PR head SHA

Determine green state by these rules (re-stated here so this merge gate does
not depend on ci-fix-monitor's generated file being regenerated unchanged):

- **Required vs. optional.** `gh pr checks <N>` (or the MCP equivalent) marks
  each check required or not, per the branch-protection rule. A check blocks
  merge only if it is **required AND not green**. A non-required check in any
  state does not block merge.
- **`skipped` is acceptable only if the same check was skipped on the base
  branch** (i.e. the workflow gates on a path filter that excludes this PR's
  changed paths). Verify by fetching the base branch's last CI run for the
  same check. A required check that is `skipped` but was NOT skipped on base
  is a path-filter regression — treat as non-green, do not merge.
- **`neutral` / `action_required` required checks are non-green.**

If all required checks are green (per the above) → go to Step 3. Otherwise
continue.

### 2b. Classify each failure

Use ci-fix-monitor's failure-type table. Then apply the **flaky-vs-real filter**:

The repo's quarantine file (`scripts/ci/quarantined-tests.txt`) quarantines
**whole test files, one repo-relative path per line** — it cannot quarantine a
single named test case inside a shared file.

- If the flaky test is the only test in its file → add the file path to the
  quarantine file (one path per line, matching the existing format).
- If the flaky test shares a file with non-flaky tests → **do not quarantine**
  (that would hide the good tests). Instead either fix the flake at the root,
  or skip just that case via `test.skip(...)` / `test.if(...)` and escalate.
- **Never** write a test name, test path with `>`, or any non-path token into
  the quarantine file — non-path lines are silently ignored and the flake is
  hidden, not handled.

Do not source-patch a flake under time pressure. If unsure whether a failure is
a flake or a real regression, check whether the same check failed on `main`'s
last CI run; if it did, the failure is pre-existing and should be reported,
not fixed as if this PR introduced it.

### 2c. Concurrency guard

Before pushing:

1. Record `git rev-parse HEAD` (local) and the remote head SHA for the branch.
2. Push.
3. If the push is rejected because the remote moved (someone else pushed
   between your fetch and your push), **abort this iteration**, re-fetch,
   then **rebase your local working branch onto the new remote head** before
   retrying — otherwise the next push is rejected again on the same stale
   local base. Never force-push over a collaborator's commit.
   `--force-with-lease` is the only force-push allowed (rebase path),
   precisely because it refuses to overwrite a remote that moved. If a
   race-abort recurs 3× without progress (a sustained concurrent-push storm),
   escalate per Step 5 as a concurrent-push terminal rather than loop.

### 2d. Exhaustive-research discipline before each fix

Do not surface-fix a symptom. Before writing the fix:

- Read the **full** failure log, not just the tail. The root cause is often
  earlier in the log than the assertion.
- Confirm the failure is not pre-existing on `main` (fetch main's last CI run
  for the same check).
- Identify the root cause, not the proximate error line.

### 2e. Fix

Apply ci-fix-monitor's recipe for the classified failure type. Use commit-pr's
push discipline for the commit and push.

### 2f. Wait for the new check run on the new HEAD

Do not push a second time until the prior push's CI result is confirmed. CI
runs against a specific SHA; a second push before the first settles creates
ambiguity about which run is authoritative.

### 2g. Decrement

Decrement the iteration counter. If 0 → stop (Step 5). Otherwise loop to 2a.

## Step 3 — Pre-merge staleness re-check (run ONCE, after green)

Defense-in-depth re-reads. **These share the GitHub API transport**, so they
are not independent of Step 2's fetch — they catch stale-state merges against
a single upstream, not against a total API outage. The genuinely independent
gate is Step 4b.

1. Re-fetch check runs for the **current** PR head SHA. If any required check
   is stale (ran against an older SHA) → `gh run rerun --failed` for the
   transient/failed run, or wait. Never merge on a stale-green check.
2. Re-verify `mergeable: MERGEABLE` + `mergeStateStatus: CLEAN` (a base push
   or merge-queue entry can change this between green-detection and merge).
3. Re-confirm `reviewDecision: APPROVED` (a reviewer can un-approve).

If any of these fail → back to Step 2 (counts as a new iteration against the
budget) or abort if the budget is exhausted.

## Step 4 — Merge

### 4a. Execute the merge

```
gh pr merge <N> --squash
```

- **Squash only.** `contributing.md` mandates squash because release-please
  reads the squash-commit title (which equals the PR title) as the
  conventional-commit message. Do not use `--merge` or `--rebase`.
- **No `--delete-branch`.** The repo has no branch-deletion convention; do not
  invent one.
- Capture the squash-commit SHA from the success output for Step 4b.

If `gh pr merge` returns "not mergeable", "merge conflict", or any error →
**do not retry blindly.** Abort and report. A clean merge is expected because
Step 3 just confirmed `CLEAN`; an error here means state changed under you and
must be investigated, not papered over with a retry.

### 4b. Post-merge confirmation (the independent gate)

Confirm the merge via a **different system** than the GitHub check-status API —
the local git object DB — so this gate does not share the stale-fetch failure
mode of Steps 2 and 3:

```
git fetch origin <base-branch>
git rev-parse origin/<base-branch>
```

The captured squash-commit SHA from 4a must equal `origin/<base-branch>`. The
GitHub API can report `state: MERGED` under eventual-consistency lag; the local
object DB cannot lie — once fetched, the commit either is or is not the base
tip.

- If they match → success. Report the squash-commit SHA and that the PR is
  merged.
- If `gh pr merge` returned success but the fetched base tip does not match →
  wait and re-fetch at most 2 more times (~1 min apart) to absorb
  eventual-consistency lag. **Do not issue a second `gh pr merge`** — a
  double-merge attempt is itself an error state. If the base tip still does
  not match after those re-fetches, escalate per Step 5 as a post-merge
  mismatch terminal; do not loop further.

## Step 5 — Escalation (non-merge terminals)

On any non-merge terminal, report:

- the terminal reason (budget exhausted / base not green / un-approval /
  unrecoverable fix / user abort / merge API error / post-merge mismatch /
  sustained concurrent-push),
- attempts made (out of 5),
- the last failing check name and a short log excerpt,
- the current HEAD SHA,
- whether the branch is still ahead of remote.

Do not silently exit on a failure. Every non-merge exit is an escalation.

## Anti-rationalization

Ignore these thoughts; they are shortcuts that cause broken merges:

- "Checks were green a minute ago, just merge." → No. Re-verify (Step 3).
- "Skip the iteration cap, I'm close." → No. Escalate at 0.
- "This flake looks source-fixable, patch it." → No. Quarantine (file-level
  only) or `test.skip` + escalate; never source-patch under time pressure.
- "Force-push to overwrite." → No. `--force-with-lease` only; abort on race.
- "Merge returned ok, we're done." → No. Confirm via Step 4b (local git).
- "The repo is too large to monitor this carefully." → No. Quality wins.

## Relationship to other skills

- **ci-fix-monitor**: owns the failure-classification table and per-type fix
  recipes. This skill composes it.
- **commit-pr**: owns the commit/push discipline. This skill composes it for
  every push inside the loop.
- **swarm-pr-subscribe**: owns background PR monitoring and event triage. This
  skill is the explicit, user-invoked, merge-terminated path; it does not
  depend on the background poller.
- **swarm-pr-review** / **swarm-pr-feedback**: own review and known-feedback
  resolution. This skill assumes that work is already done (Step 1 gate 2).
