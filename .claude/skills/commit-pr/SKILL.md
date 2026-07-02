---
name: commit-pr
description: >
  Apply when committing, pushing, opening or updating a PR, writing a pull request,
  creating release notes, or closing out remote CI. Enforces the opencode-swarm
  invariant audit, release-note fragment workflow, full validation suite, issue
  comment requirement, and post-PR lifecycle rules.
effort: medium
---

# Commit & PR Protocol

Follow every step in order. Do not skip steps.

## Step -1 - Mandatory invariant audit

Before any build, test, push, or PR action, read:

1. [`../../../AGENTS.md`](../../../AGENTS.md)
2. [`../../../docs/engineering-invariants.md`](../../../docs/engineering-invariants.md)

For every touched invariant, prepare concrete evidence for the PR body. The PR body must include:

```md
## Invariant audit
- 1 (plugin init): touched / not touched - <evidence>
- 2 (runtime portability): touched / not touched - <evidence>
- 3 (subprocesses): touched / not touched - <evidence>
- 4 (.swarm containment): touched / not touched - <evidence>
- 5 (plan durability): touched / not touched - <evidence>
- 6 (test_runner safety): touched / not touched - <evidence>
- 7 (test writing): touched / not touched - <evidence>
- 8 (session state): touched / not touched - <evidence>
- 9 (guardrails/retry): touched / not touched - <evidence>
- 10 (chat/system msg): touched / not touched - <evidence>
- 11 (tool registration): touched / not touched - <evidence>
- 12 (release/cache): touched / not touched - <evidence>
```

If a touched invariant cannot be proven from source and test output, do not push.

### Required validations for touched invariants

If invariants 1, 2, or 3 are touched, run all three:

```bash
bun run build
node scripts/repro-704.mjs
node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"
```

If invariant 3 is touched, audit changed source files for subprocess use:

```bash
git diff --name-only origin/main..HEAD | xargs -r grep -nE "bunSpawn\(|spawn\(|spawnSync\(" || true
```

If invariant 11 is touched, run:

```bash
bun --smol test tests/unit/config --timeout 60000
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done
```

If invariant 7 is touched, confirm the writing-tests skill was loaded and that new test seams avoid leaking `mock.module`.

## Step 0 - Session start hygiene

Run before publication work:

```bash
git fetch origin main
rm -f .swarm/evidence/*.json
git status --short
```

On Windows, prefer temporary save branches over `git stash`. If you must stash, use `git stash push --include-untracked` and verify the stash contents.

## Step 1 - Commit and PR titles

Use `<type>(<scope>): <description>` exactly.

- description is lowercase and does not end with a period
- allowed types: `feat`, `fix`, `perf`, `revert`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`

Choose the PR title type by the main change:

- new capability -> `feat`
- bug fix only -> `fix`
- docs or chore only -> non-bump types

The squash merge commit message must match the PR title exactly.

> **Note:** The PR title MUST follow `<type>(<scope>): <description>` exactly — CI runs `action-semantic-pull-request` which will fail the `check-title` job if the format is wrong. Do not deviate from this format.

## Step 2 - Release note fragment

Create a pending release fragment and do not calculate a version manually.

Required file shape:

```text
docs/releases/pending/<unique-slug>.md
```

The fragment should cover:

- what changed
- why
- migration steps, if any
- breaking changes, if any
- known caveats

Do not manually edit:

- `package.json` version
- `CHANGELOG.md`
- `.release-please-manifest.json` — exception: reconciliation when the manifest desyncs from actual releases (see below)

### Release-please manifest desync

`.release-please-manifest.json` is the version source of truth for release-please. If it desyncs from the actual published release (e.g., `7.26.0` in manifest but `v7.27.1` on GitHub), release-please will propose a version that goes backwards.

**Common cause:** An older release PR (e.g., `chore(main): release 7.26.0`) merges after a newer one (`chore(main): release 7.27.1`). Both PRs modify the manifest, so the later one to merge wins — regardless of which version is higher.

**Detection:** If a release-please PR proposes a version that seems too low, check:
1. `gh release list --limit 5` — what's the latest published release?
2. `git show origin/main:.release-please-manifest.json` — what does the manifest say?
3. If different, the manifest is desynced.

**Fix:** Open a PR that updates `.release-please-manifest.json` to match the actual latest release (e.g., `"7.27.1"`). Close the incorrect release PR with explanation. After the manifest fix merges, release-please will auto-create a correct release PR.

## Step 3 - Mandatory validation suite

Run the full validation stack before pushing. The exact commands may be narrowed only when the repo contract or current task explicitly justifies it in evidence, not by intuition.

### Pre-flight

`dist/` is generated output and is **not** committed (#1047). Confirm the build still
succeeds and the bundle loads — do not stage `dist/`:

```bash
bun run build
node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"
```

### Tier 1 - quality

Run both linter AND formatter — e.g., `bunx @biomejs/biome@<version> check --write .` or equivalent — because CI quality gates reject code that passes tests but fails style validation. **Pin the tool version** to match the version in `package.json` (`@biomejs/biome`); unversioned `bunx biome` resolves to a different version than the CI gate uses.

```bash
bun run typecheck
bunx @biomejs/biome@<version> ci .
```

### Tier 2 - unit tests

```bash
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done
for f in tests/unit/services/*.test.ts; do bun --smol test "$f" --timeout 30000; done
for f in tests/unit/agents/*.test.ts; do bun --smol test "$f" --timeout 30000; done
for f in tests/unit/hooks/*.test.ts; do bun --smol test "$f" --timeout 30000; done
bun --smol test tests/unit/cli tests/unit/commands tests/unit/config --timeout 120000
```

If agent prompt text changed, grep for the changed text in tests and rerun every matching file individually.

### Tier 3 - integration

```bash
bun test tests/integration ./test --timeout 120000
```

### Tier 4 - security and adversarial

```bash
bun test tests/security --timeout 120000
bun test tests/adversarial --timeout 120000
```

### Tier 5 - smoke

```bash
bun test tests/smoke --timeout 120000
```

### Pre-existing failure handling

If a failure looks unrelated, prove it on clean `origin/main` before carrying it into the PR body:

```bash
git worktree add /tmp/repro-check origin/main
bun --smol test /tmp/repro-check/<path-to-failing-test> --timeout 30000
git worktree remove /tmp/repro-check
```

If the failure reproduces on `main`, document it under `## Pre-existing failures`. Do not silently inherit it.

### dist/ is generated, not committed

`dist/` is build output and is git-ignored (#1047); do **not** stage or commit it, and
there is no `dist-check` drift gate. The authoritative artifact check is `package-check`,
which runs `npm pack` and verifies the packed tarball is complete (type declarations,
grammar assets), installs it in a temp project, imports it under Node, and runs the CLI.

A `package-check` failure is a source / build / `package.json#files` problem — fix the
source or manifest and rebuild; never "commit dist to make CI green." CI builds `dist/`
itself (the `unit`, `package-check`, and `smoke` jobs run `bun run build`), and
release/publish builds from source.

## Step 4 - Workflow changes

If any `.github/workflows/*.yml` file changed, every third-party `uses:` must be pinned to a full 40-character SHA.

## Step 5 - History shape

Before opening a PR, verify no local-only files are staged:

```bash
git diff --name-only HEAD origin/main | grep -E '\.(local\.json|vscode|idea)' || true
```

Prefer a single clean commit for the branch before initial PR publication:

```bash
git fetch origin main
git log --oneline origin/main..HEAD
git reset --soft origin/main
git commit -m "type(scope): description"
git push --force-with-lease -u origin <branch-name>
```

If a review cycle is already active and inline comments depend on current SHAs, avoid resquashing until threads are resolved.

If pushing to a PR branch owned by another agent or bot, push to the PR's actual head branch:

```powershell
$prBranch = gh pr view <number> --json headRefName --jq '.headRefName'
git fetch origin $prBranch
git push origin "<your-local-branch>:$prBranch" --force-with-lease
```

### Pre-push: Push Protection and Canonical Remote

Before `git push`, run both checks:

#### Push protection scan

GitHub push protection blocks commits containing literal secret patterns. This bit the
first commit of PR #1472 — a test file with a literal `sk_live_*` Stripe fixture
pattern was pushed before the string-concatenation workaround was applied.

**The primary check (pre-push, after commit exists):**

```bash
git log origin/main..HEAD -p | grep -E "$(printf '%s' "${PREFIX:-sk_live}|ghp_|xox[abprs]-|AKIA|eyJ|AIza")" || true
```

**The optional pre-commit add-on (staged changes only):**

```bash
git diff --cached | grep -E "$(printf '%s' "${PREFIX:-sk_live}|ghp_|xox[abprs]-|AKIA|eyJ|AIza")" || true
```

Forbidden patterns: Stripe (`sk_live_*`), GitHub (`ghp_*`), Slack (`xox[abprs]-*`),
AWS (`AKIA*`), JWT (`eyJ*`), Google API (`AIza*`).

**The fix:** Construct test fixtures via string concatenation rather than literal
patterns. For example:

```typescript
// Wrong — triggers push protection:
const stripeKey = 'sk_live_' + '1234567890abcdefghijklmn'

// Right — split the literal so it never appears verbatim in source:
const stripeKey = 'sk_' + 'live_' + '1234567890abcdefghijklmn'
```

> **Note:** This scan is a best-effort heuristic. It will not catch deliberately obfuscated patterns (e.g., base64 or hex encoding, runtime string assembly). For genuinely sensitive keys, use environment variables or a secret store — never commit credentials to source.

#### Canonical remote resolution

When a repo has multiple remotes (e.g. `zaxbysauce/opencode-swarm` and
`ZaxbyHub/opencode-swarm`), pushing to the wrong remote causes `gh pr create` to
fail with "No commits between <canonical>:main and <mirror>:<branch>". This happened
on PR #1472.

**The check:** `git remote -v` before push. Identify the canonical-org remote.

**The rule:** Push to the canonical-org remote explicitly:

```bash
git push -u <canonical-remote> <branch>
```

Create the PR against the canonical repo:

```bash
gh pr create --repo <canonical-org>/<repo>
```

**Heuristic for identifying the canonical remote:** the canonical remote is the one whose URL points to the owning organization (e.g. `github.com/<org>/<repo>.git`), not a personal fork or mirror. When the owning org differs from the local fork's owner, the org-owned remote is canonical. Example: `github.com/ZaxbyHub/opencode-swarm.git` is canonical; `github.com/zaxbysauce/opencode-swarm.git` is a personal fork.

## Step 6 - PR creation

PR body requirements:

- `Closes #<issue-number>` as the first line when the PR resolves an issue
- `## Summary`
- `## Invariant audit`
- `## Test plan`

### Publication-gate evidence

A repository publication gate (`.github/hooks/pr-publication-gate.json` ->
`scripts/copilot-pr-publication-gate.sh`) may block `gh pr create`, `gh pr edit`,
and `gh pr ready` until publication evidence exists. Before publishing, write:

- `.swarm/evidence/pr_body.md` — the exact PR body you will publish (must contain
  `## Summary`, `## Invariant audit`, and `## Test plan`).
- `.swarm/evidence/commit-pr-validation.md` — the validation commands you ran and
  their results.

These files live under `.swarm/` (runtime state, never committed) and double as the
evidence the gate checks. Keep them current if you edit the PR body or rerun
validation. The CI `pr-standards` check enforces the same body contract server-side.

PowerShell-safe pattern:

```powershell
$body = @"
Closes #<issue-number>

## Summary
- <bullet 1>
- <bullet 2>

## Invariant audit
- 1 (plugin init): not touched - <evidence>

## Test plan
- [ ] <validation item>
"@
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$prBodyPath = Join-Path ([System.IO.Path]::GetTempPath()) "pr_body.txt"
[System.IO.File]::WriteAllText($prBodyPath, $body, $utf8NoBom)
gh pr create --title "<type>(<scope>): <description>" --body-file $prBodyPath --base main
```

## Step 6a - PR monitoring subscription

After PR creation, if the project uses PR monitoring (`pr_monitor.enabled: true`
in resolved opencode-swarm config), the new PR must be subscribed for background
monitoring:

- **Automatic (default):** when `pr_monitor.auto_subscribe_on_pr_create` is
  enabled (default `true`), the subscription is created automatically after
  `gh pr create` succeeds — no command needed. Verify with `/swarm pr status`
  if in doubt.
- **Manual fallback:** when auto-subscribe is disabled or did not fire, run
  `/swarm pr subscribe <pr-url>`, which records the subscription and
  lazy-starts the polling worker.

The post-subscription monitoring protocol — event intake, triage
(fix / ask / skip), bounded-retry escalation, and terminal-state behavior —
lives in the swarm-pr-subscribe skill (`../swarm-pr-subscribe/SKILL.md`).

## Step 6.5 - Issue comment

If the PR closes an issue, post a comment on the issue. This is mandatory.

The issue comment must include:

1. the PR link
2. what changed
3. how to use it
4. migration steps or "No migration required"

PowerShell-safe pattern:

````powershell
$comment = @"
Fixed in PR #<pr-number>.

## What changed
- <bullet 1>
- <bullet 2>

## How to use
```json
{ "config": "example" }
```

## Migration
No migration required.
"@
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$issueCommentPath = Join-Path ([System.IO.Path]::GetTempPath()) "issue-comment.txt"
[System.IO.File]::WriteAllText($issueCommentPath, $comment, $utf8NoBom)
gh issue comment <issue-number> --body-file $issueCommentPath
````

## Commit messages

`git commit -m "..."` with parens, brackets, backticks, or dollar-signs in the message fails on PowerShell because the shell parses them as expressions. Write the commit message to a UTF-8 (no BOM) file first and use `git commit -F <file>`.

PowerShell-safe pattern:

```powershell
$msg = @"
<type>(<scope>): <description>

<optional body — note this is for the git commit message, NOT the PR body>
"@
$utf8NoBom = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$commitMsgPath = Join-Path ([System.IO.Path]::GetTempPath()) "commit-msg.txt"
[System.IO.File]::WriteAllText($commitMsgPath, $msg, $utf8NoBom)
git commit -F $commitMsgPath
```

Apply this pattern for any commit message containing special characters, multi-paragraph bodies, or code blocks. The plain `git commit -m "..."` form remains fine for short single-line messages with no special characters.

If the PR merged before this was done, post the missing issue comment immediately.

## Step 7 - Existing PR follow-up and closeout

If a PR already exists for the branch:

1. do not open a second PR
2. inspect unresolved PR feedback surfaces before updating or readying the PR: review threads/comments, requested-changes reviews, CI/check failures, mergeability/conflicts, and whether check data belongs to the current head SHA
3. use `../swarm-pr-feedback/SKILL.md` when feedback needs fixes before closeout
4. update the existing PR body when summary, invariant evidence, test counts, caveats, or pre-existing failure notes changed
5. keep the PR draft while follow-up edits are still expected or required checks are still pending
6. mark the PR ready only after the body is current and required remote checks are green, unless the user explicitly wants it ready earlier
7. after any follow-up push or force-push, verify the PR head matches the expected commit and that reported checks belong to the current `headRefOid`:

```powershell
gh pr view <number> --json headRefOid,body,isDraft,state,mergeable,mergeStateStatus,statusCheckRollup,url
```

Useful commands:

```powershell
gh pr edit <number> --body-file "$env:TEMP\pr_body.txt"
gh pr ready <number>
gh pr checks <number> --watch --fail-fast
```

### Conflict closeout

After resolving merge conflicts or syncing a stale branch:

1. verify there are no local unmerged paths or conflict markers,
2. push the conflict-resolution commit,
3. verify GitHub reports both `mergeable: MERGEABLE` and
   `mergeStateStatus: CLEAN`, not merely that local markers are gone, and
4. keep a conflict/branch-drift item in the PR closure ledger when it affected
   the PR.

If GitHub still reports `DIRTY`, `BLOCKED`, or stale checks after local conflict
resolution, fetch current `origin/main` again and re-evaluate before claiming the
conflict is resolved.

### GitHub auto-merge race condition

With a merge queue enabled, prefer queuing over manual freshness rebases, which
avoids this race entirely. It can still occur if you rebase manually: when `main`
advances while your PR is open, GitHub's PR sync machinery may **automatically push a
merge commit to your branch** in the window between when you fetch and when you push.
This is distinct from a conflict — it is GitHub creating a merge commit on your behalf
without rebuilding generated outputs (lockfiles, etc.).

Symptoms:
- `git push` is rejected with "fetch first" even though you just fetched
- `git log HEAD..origin/<branch>` shows a commit authored by GitHub/the repo owner with message `Merge branch 'main' into <branch>`
- generated outputs (e.g. lockfiles) on that auto-merge commit are stale because it was not rebuilt

Recovery:
```bash
git fetch origin <branch>
git log HEAD..origin/<branch>   # confirm it's only the GitHub auto-merge
# Your local commit is correct. Force-push it:
git push origin <branch> --force-with-lease
```

After force-pushing, verify the PR head SHA updated and cancel any CI run
targeting the superseded auto-merge SHA to unblock concurrency:

```powershell
gh run list --branch <branch> --limit 5 --json databaseId,headSha,status,workflowName
gh run cancel <stale-run-id>
```

### Check closeout

`gh pr checks --watch --fail-fast` is useful but can lag or flatten matrix and
downstream jobs. When the PR checks view looks stale, missing, or inconsistent,
use the workflow run as the authoritative detail:

> **MCP environments:** When using GitHub MCP tools instead of `gh`, prefer
> `get_check_runs` over `get_status`. The `get_status` method uses GitHub's
> legacy commit status API: it returns `state: "pending"` even when all GitHub
> Actions jobs are green, because Actions creates check-runs (not legacy
> statuses). `get_check_runs` returns the actual job results.

```powershell
gh run view <run-id> --json headSha,status,conclusion,jobs,url
```

Keep watching after unit jobs pass; this repository may enqueue integration and
smoke jobs later in the same CI run. Do not call the PR green until the current
`headRefOid` has all required jobs completed successfully.

If a previous run from an older PR head is still in progress or already failed
and is blocking the current head's workflow through concurrency, inspect it with
`gh run view <run-id> --json headSha,status,conclusion,jobs,url`. Cancel only
obsolete older-head runs that are no longer relevant to the PR head you are
validating, then wait for the current-head checks to complete.

If you edit the PR body after checks are green, expect PR Standards / title
checks to rerun. Re-check before claiming final green or merge-readiness.

### Merge queue (current-base validation)

When `main` has a GitHub **merge queue** enabled, do not rebase or force-push a PR
*solely because `main` advanced*. Once required checks and review are green, add the
PR to the merge queue; GitHub re-runs the required workflows against the queued
change on top of the latest `main` (and any earlier queued PRs) before merging, so
manual "freshness" rebases are unnecessary.

Still rebase/force-push when there is a **real** reason: a genuine merge conflict,
a stale review thread that depends on current SHAs, or a correctness issue that only
appears against current `main`. The queue handles up-to-date validation; it does not
resolve conflicts for you.

Required workflows trigger on both `pull_request` and `merge_group`. PR-only checks
(title/body validation) no-op to success on `merge_group` because the PR already
satisfied them before being queued.

## Step 8 - Cancelled jobs and skipped dependents

If a required GitHub Actions job is `cancelled` and downstream jobs are `skipped`:

1. inspect the run:

```powershell
gh run view <run-id> --json status,conclusion,jobs,url
```

2. if the cancellation looks like orchestration or infrastructure rather than a code failure, rerun the failed or cancelled jobs:

```powershell
gh run rerun <run-id> --failed
```

3. re-check the PR until required jobs are green:

```powershell
gh pr checks <number> --watch --fail-fast
```

Do not call the PR green or merge-ready while a required job is `cancelled`, `skipped`, `in_progress`, or otherwise non-green unless the user explicitly accepts that state.

## Step 9 - Pre-merge checklist

- [ ] invariant audit is complete and current
- [ ] required build and validation commands ran for touched invariants
- [ ] `test_runner` was not used with broad repo-validation scopes
- [ ] release fragment exists and version files are untouched
- [ ] `dist/` was NOT staged (it is generated output, not committed — #1047)
- [ ] PR body has `Closes`, `## Summary`, `## Invariant audit`, and `## Test plan`
- [ ] if this was review follow-up, the PR body was refreshed to match current evidence
- [ ] if the PR resolves an issue, the issue comment was posted with PR link, what changed, how to use it, and migration notes
- [ ] if any required job was cancelled and dependent jobs skipped, the run was rerun or the non-green state was explicitly accepted by the user
- [ ] for high-risk work (security, isolation, IPC, auth, payments, migrations), an independent adversarial review subagent ran before the final substantive push and all confirmed findings were addressed — if this was not done before pushing, run the review now and force-push a corrected commit before marking the PR ready
- [ ] all required CI checks are green before calling the PR merge-ready
