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
- `.release-please-manifest.json`

## Step 3 - Mandatory validation suite

Run the full validation stack before pushing. The exact commands may be narrowed only when the repo contract or current task explicitly justifies it in evidence, not by intuition.

### Pre-flight

```bash
bun run build
git diff --exit-code -- dist/
```

### Tier 1 - quality

Run both linter AND formatter — e.g., `bunx biome check --write .` or equivalent — because CI quality gates reject code that passes tests but fails style validation.

```bash
bun run typecheck
bunx biome ci .
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

## Step 6 - PR creation

PR body requirements:

- `Closes #<issue-number>` as the first line when the PR resolves an issue
- `## Summary`
- `## Invariant audit`
- `## Test plan`

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
$body | Out-File "$env:TEMP\pr_body.txt" -Encoding UTF8
gh pr create --title "<type>(<scope>): <description>" --body-file "$env:TEMP\pr_body.txt" --base main
```

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
$comment | Out-File "$env:TEMP\issue-comment.txt" -Encoding UTF8
gh issue comment <issue-number> --body-file "$env:TEMP\issue-comment.txt"
````

If the PR merged before this was done, post the missing issue comment immediately.

## Step 7 - Existing PR follow-up and closeout

If a PR already exists for the branch:

1. do not open a second PR
2. update the existing PR body when summary, invariant evidence, test counts, caveats, or pre-existing failure notes changed
3. keep the PR draft while follow-up edits are still expected or required checks are still pending
4. mark the PR ready only after the body is current and required remote checks are green, unless the user explicitly wants it ready earlier
5. after any follow-up push or force-push, verify the PR head matches the expected commit:

```powershell
gh pr view <number> --json headRefOid,body,isDraft,state,statusCheckRollup,url
```

Useful commands:

```powershell
gh pr edit <number> --body-file "$env:TEMP\pr_body.txt"
gh pr ready <number>
gh pr checks <number> --watch --fail-fast
```

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
- [ ] `dist/` was rebuilt and staged when tracked outputs changed
- [ ] PR body has `Closes`, `## Summary`, `## Invariant audit`, and `## Test plan`
- [ ] if this was review follow-up, the PR body was refreshed to match current evidence
- [ ] if the PR resolves an issue, the issue comment was posted with PR link, what changed, how to use it, and migration notes
- [ ] if any required job was cancelled and dependent jobs skipped, the run was rerun or the non-green state was explicitly accepted by the user
- [ ] all required CI checks are green before calling the PR merge-ready
