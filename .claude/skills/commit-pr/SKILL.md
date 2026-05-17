---
name: commit-pr
description: >
  Apply when committing, pushing, opening a PR, writing a pull request, creating release
  notes, or updating a changelog. Enforces conventional commit format, mandatory release
  notes, 5-tier test suite, SHA-pinning for workflow changes, and correct PR body format.
effort: medium
---

## Commit & PR Protocol

Follow every step in order. Do not skip steps.

### Step −1 — ⛔ MANDATORY: Engineering invariant audit (read AGENTS.md, not "looks fine")

**Before** running any test tier, before any build, before any push: read [`AGENTS.md`](../../../AGENTS.md) at the repo root and audit your change against the 12 non-negotiable invariants. The invariant list and the historical failure map are in [`docs/engineering-invariants.md`](../../../docs/engineering-invariants.md).

For every invariant **touched** by this PR (not "maybe touched" — actually touched), produce a one-line entry of the form `<id> (<short name>): touched — <evidence>`. Evidence must be a concrete artifact: a command + its output, a test that proves the invariant, a grep showing no remaining anti-patterns, or a quoted spec citation. "Looks fine" is not evidence. The PR body must include a `## Invariant audit` section in the format shown in `AGENTS.md` (12 lines, one per invariant, each marked touched/not-touched with evidence).

Hard stop:

> **If any touched invariant cannot be proven from source and test output, do not push.**

#### Required invariant-specific validations (run when the named invariants are touched)

**(1, 2, 3) Plugin initialization, runtime portability, or any subprocess change** — run all three:

```bash
bun run build
node scripts/repro-704.mjs
node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"
```

The `repro-704.mjs` harness asserts plugin entry resolves under a deadline; the `dist import` line catches Node-ESM regressions (top-level `bun:` imports, broken default export shape) before CI does.

**(3) Subprocesses** — grep every changed file for spawn call sites and account for each one in the audit:

```bash
git diff --name-only origin/main..HEAD | xargs -r grep -nE "bunSpawn\(|spawn\(|spawnSync\(" || true
```

For every match, the `## Invariant audit` evidence must confirm the call passes `cwd` (or `git -C <directory>` for Git CLI calls), `stdin: 'ignore'` (unless intentionally interactive), `timeout`, bounded stdio, and `proc.kill()` in `finally`.

**(11) Tool registration** — run the tool / config tests:

```bash
bun --smol test tests/unit/config --timeout 60000
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done
```

`/swarm doctor tools` is the runtime equivalent — its tests must remain green.

**(7) Test writing** — confirm you loaded the writing-tests skill (`.claude/skills/writing-tests/SKILL.md` or `.opencode/skills/writing-tests/SKILL.md`). Confirm any new mocks use a file-scoped `_internals` DI seam, not `mock.module`, OR are isolated to a test file whose `mock.module` cannot leak into other suites.

**(6) `test_runner` safety** — the OpenCode `test_runner` tool is for targeted agent validation only. Do NOT use it with `scope: 'all'` or broad `'graph'` / `'impact'` scope for repo validation. For repo validation, use the shell commands in Step 5 below.

### Step 0 — Session start hygiene

**Run before anything else.** Prevents the three most common CI failures (stale state, stale base, dirty working tree).

```bash
# Ensure you're on the latest main as your branch point
git fetch origin main

# Create (or verify) a branch rooted at the latest main
# If already on a feature branch, skip this line
# git switch -c <branch> origin/main

# Clear stale evidence files from prior sessions — these pollute
# evidence-first gate checks and cause non-deterministic test failures
rm -f .swarm/evidence/*.json

# Verify working tree is clean — no uncommitted changes from prior sessions
git status --short
```

If `git status` shows uncommitted changes, either commit them (if they're part of this PR) or move them aside. **On Windows, `git stash` is unreliable** — it can silently drop untracked files and fail with `EBUSY` errors when file handles are held by running processes. Prefer one of these safer alternatives:

```bash
# Option A — commit work-in-progress to a temporary branch, then switch back
git switch -c save/prior-session
git add -A && git commit -m "chore: save prior session state"
git switch -c my-feature-branch origin/main
```

If you must use stash, always pass `--include-untracked` (`git stash push --include-untracked`) to avoid silently losing untracked files, and verify with `git stash show -p` that all expected files were captured before proceeding.

### Step 1 — Format every commit message correctly

Use `<type>(<scope>): <description>` exactly:
- Description must be **lowercase** and **not end with a period**
- Scope is optional but encouraged
- Allowed types: `feat`, `fix`, `perf`, `revert`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`
- For a breaking change, append `!` to the type (e.g. `feat!:`) or add a `BREAKING CHANGE:` footer

Valid: `feat(architect): add retry backoff to SME delegation`
Invalid: `Fix stuff`, `feat: Add new feature.`, `feature: new thing`

### Step 2 — Choose the correct PR title type

The PR title is the squash merge commit message. Choose based on primary change:
- New capability → `feat` (minor bump)
- Bug fix only → `fix` (patch bump)
- Mixed feat + fix → use `feat` (minor subsumes patch)
- `docs`/`chore`/`refactor`/`test`/`ci`/`build` only → no version bump is triggered

### Step 3 — Create a pending release-note fragment

⛔ **Do NOT** calculate `NEXT_VERSION`. ⛔ **Do NOT** create `docs/releases/vX.Y.Z.md`. ⛔ **Do NOT** write to a shared `docs/releases/unreleased.md` (same conflict hotspot, just relocated). release-please picks the actual version; the release workflow aggregates fragments at release time.

1. Choose a short, descriptive, kebab-case slug that names the change. Pick something unlikely to collide with other open PRs — concurrent PRs each adding a *different* file produces zero merge conflicts.
2. Create `docs/releases/pending/<your-slug>.md` with freeform markdown covering:
   - **What changed** — changes grouped by theme
   - **Why** — motivation (bug report, feature request, hardening)
   - **Migration steps** — if any API, config, or behavior changed
   - **Breaking changes** — if any
   - **Known caveats** — anything users should watch out for
3. Do not include a version prefix in the heading (`# v7.21.4`). Use a descriptive topic heading: `# <topic>` (e.g. `# Spec-drift self-acknowledgment guardrail (issue #890)`).

Examples of good slugs:
- `docs/releases/pending/guardrails-transient-node-errors.md`
- `docs/releases/pending/spec-drift-self-ack-guardrail.md`
- `docs/releases/pending/phase-complete-durable-gate-proof.md`

This file is **mandatory on every user-visible PR, no exceptions**, including one-line fixes. The aggregation is implemented by `scripts/release-notes-fragments.mjs`, invoked by the `update-pr-notes` and `update-release-notes` jobs in `.github/workflows/release-and-publish.yml`.

### Step 4 — Never touch these files manually

Do **not** edit `package.json` version field, `CHANGELOG.md`, or `.release-please-manifest.json`. Release-please manages them; manual edits cause merge conflicts and break the pipeline.

### Step 5 — ⛔ MANDATORY: Build + run the full 5-tier test suite before pushing

**This step is MANDATORY. It is not optional, skippable, or conditional.**

Every tier MUST be run in order, regardless of:
- Whether the swarm's internal QA gates already ran lint/checks (swarm scope ≠ CI scope)
- Whether the change looks trivial or cosmetic
- Whether tests passed locally in isolation
- Whether you are in a hurry

Skipping this step WILL cause CI failures that waste time and require a follow-up commit.

#### Pre-flight: build and check dist/ drift (runs before all test tiers)

Build first. If `dist/` is tracked in the repo, verify a fresh build produces no uncommitted diffs.
CI's dist-check passes by comparing committed `dist/` against a fresh build; any diff is a hard failure.

```bash
bun run build

# Check for dist drift — MUST be clean before proceeding to tests
if git diff --exit-code -- dist/; then
    echo "dist/ is clean"
else
    echo "dist/ has uncommitted changes after build — stage and commit them:"
    echo "  git add dist/ && git commit -m \"chore: update dist artifacts\""
    echo "Then re-run this pre-flight check."
    exit 1
fi
```

If the build produces non-deterministic diffs on every run (no source changes), investigate before proceeding — this will also fail CI on every subsequent PR.

#### Run every tier in order. Fix failures before proceeding.

```bash
# Tier 1 — quality
bun run typecheck
bunx biome ci .   # MUST run on the full project — never scope to modified files only.
                  # CI runs it on all files; a scoped run will miss errors in files you
                  # touched indirectly (e.g. reformatted by another tool, or modified via
                  # biome --write on one file but not re-checked globally).
                  #
                  # If you ran `bunx biome check --write` to auto-fix formatting,
                  # re-run `bunx biome ci .` afterwards and commit the auto-fixed files
                  # BEFORE pushing — biome --write produces unstaged changes that will
                  # cause the quality CI check to fail on the un-fixed commit.

# Tier 2 — unit tests (per-file isolation to match CI and prevent mock conflicts)
for f in tests/unit/tools/*.test.ts; do bun --smol test "$f" --timeout 30000; done
for f in tests/unit/services/*.test.ts; do bun --smol test "$f" --timeout 30000; done
for f in tests/unit/agents/*.test.ts; do bun --smol test "$f" --timeout 30000; done
# hooks must run per-file — batch mode can mask failures that CI's per-file isolation catches
for f in tests/unit/hooks/*.test.ts; do bun --smol test "$f" --timeout 30000; done
bun --smol test tests/unit/cli tests/unit/commands tests/unit/config --timeout 120000

**Pre-push mock contract verification: run after Tier 2.**
After unit tests pass, verify that no mock contract was silently broken by a refactor.

1. Identify test files that mock modules you changed:
   ```bash
   # bash — match by filename stem (robust across relative path depths)
   for src_file in $(git diff --name-only origin/main..HEAD -- 'src/**/*.ts'); do
     stem=$(basename "$src_file" .ts)
     grep -rl "mock.module\|vi.mock" tests/ --include="*.ts" | while read test_file; do
       if grep -q "$stem" "$test_file"; then
         echo "$test_file"
       fi
     done
   done | sort -u
   ```
   ```powershell
   # PowerShell — match by filename stem
   $changed = git diff --name-only origin/main..HEAD -- 'src/**/*.ts'
   foreach ($src in $changed) {
     $stem = [System.IO.Path]::GetFileNameWithoutExtension($src)
     Get-ChildItem -Recurse tests/ -Filter "*.test.ts" |
       Select-String -Pattern "mock\.module|vi\.mock" |
       Where-Object { $_.Line -match [regex]::Escape($stem) } |
       ForEach-Object { $_.Path }
   } | Sort-Object -Unique
   ```
2. Run each matching test file individually:
   ```bash
   for f in <matching-test-files>; do bun --smol test "$f" --timeout 30000 || exit 1; done
   ```
   ```powershell
   foreach ($f in @("tests/path/to/test1.test.ts")) { bun --smol test $f --timeout 30000 }
   ```
3. If any fail with `SyntaxError: Export named 'X' not found`, the `mock.module()` factory is missing exports — update it per the writing-tests skill's "mock.module() Export Completeness" section.
4. If any fail with `TypeError: undefined is not an object` or empty assertion values, the mock return shape doesn't match the new function contract — update the mock's `mockResolvedValue()` to include new required fields.

# Tier 3 — integration tests
# IMPORTANT: always run Tier 3 after fixing Tier 2 failures — the same root cause
# often appears in integration test fixtures that unit tests don't cover.
bun test tests/integration ./test --timeout 120000

# Tier 4 — security and adversarial tests
bun test tests/security --timeout 120000
bun test tests/adversarial --timeout 120000

# Tier 5 — smoke (no rebuild — already done in pre-flight)
bun test tests/smoke --timeout 120000
```

**Routing console calls through a debug-gated logger: extra step required.**
When you change `console.log/warn/error` to `logger.log/warn()` (which gates output behind `OPENCODE_SWARM_DEBUG=1`):
1. Grep for all tests that spy on those console methods and assert they ARE called:
   ```bash
   grep -rn "spyOn(console" tests/ --include="*.ts"
   grep -rn "toHaveBeenCalled\|console\.warn\|console\.log\|console\.error" tests/ --include="*.ts"
   ```
2. For every spy that asserts the call IS made: determine whether the original call was an operational error (e.g., `catch` block reporting a real failure). Operational errors must remain as direct `console.warn/error` — never gate them behind `logger.warn()`. Only diagnostic/trace messages should be routed through the debug-gated logger.
3. Run the affected hook test files per-file after the fix to confirm spy assertions pass.

Failing to do this breaks tests silently in isolation but fails loudly in CI's per-file run.

**Schema or field name changes: extra step required.**
When you rename a field in a Zod schema, TypeScript interface, or serialized format (e.g. `task_id` → `taskId`):
1. Grep for the old field name across ALL test files — unit AND integration:
   ```bash
   grep -rn "old_field_name" tests/ --include="*.ts"
   ```
2. Update every test fixture that writes JSON with the old field name.
3. Update every assertion that reads the old field name from parsed JSON.
4. Run Tier 2 and Tier 3 together after fixing all fixtures.

Failing to do this causes test fixtures to write stale-format JSON that passes Zod validation for the write but fails on the read path — a silent correctness hazard.

**Import rename or function signature change: extra step required.**
When a refactor renames an import, changes a function signature, or changes which function a module calls (e.g. `readMergedKnowledge` → `readContextualKnowledge`):
1. Search for the old function name across test files, scoped to imports and mock references:
   ```bash
   # bash — scoped to imports, mock factories, and mock state calls
   grep -rnE "import.*oldFunctionName|mock\(.*oldFunctionName|mockResolvedValue|mockClear|mockReset" tests/ --include="*.ts" | grep oldFunctionName
   ```
   ```powershell
   # PowerShell — scoped to imports and mock references
   Get-ChildItem -Recurse tests/ -Filter "*.test.ts" | Select-String -Pattern "oldFunctionName" | Where-Object { $_.Line -match "import|mock\(|mockResolvedValue|mockClear|mockReset" }
   ```
2. For every match, determine if the test's mock must be updated:
   - If the test imports the old name → update the import
   - If the test's `mock.module()` / `vi.mock()` provides the old name → update to the new name
   - If the test's `mockResolvedValue()` / `mockClear()` / `mockReset()` calls reference the old mock variable → update to the new variable name
3. If the new function signature requires additional data (e.g., a new required field on the return type), update all mock return values and test fixtures to include it.
4. Run each affected test file individually after fixing:
   ```bash
   for f in <affected-test-files>; do bun --smol test "$f" --timeout 30000; done
   ```
   ```powershell
   foreach ($f in @("tests/path/to/test1.test.ts", "tests/path/to/test2.test.ts")) { bun --smol test $f --timeout 30000 }
   ```

Failing to do this causes tests to reference stale function names in mocks — the mock intercepts nothing, the real function (which doesn't exist) throws, and CI fails with cryptic "received value is empty" errors.

**Agent prompt changes: extra step required.**
When you edit any agent prompt (`src/agents/*.ts`), tests that assert on prompt content will silently break even if your change appears unrelated. Before pushing:
1. Identify the text you changed or removed from the prompt.
2. Grep for that text across all test files:
   ```bash
   # bash
   grep -rn "the exact phrase you removed" tests/ --include="*.ts"
   # PowerShell
   Get-ChildItem -Recurse tests/ -Filter "*.test.ts" | Select-String "the exact phrase you removed"
   ```
3. Run every test file that matches: `bun --smol test <matching-file> --timeout 30000`.
4. If any fail, update the assertion to match the new prompt text (or remove it if the concept no longer exists).

Prompt-text tests are especially fragile because they test content, not behaviour — a refactor that seems unrelated (e.g. changing a delegation format example) can silently break assertions checking for specific template strings.

### Troubleshooting — Release workflow automation gaps

When release-please creates a release (`releases_created=true`), the `update-pr-notes` job is **skipped** because its `if` condition checks `releases_created != 'true'`. This means pending release-note fragments are NOT automatically injected into the next release PR body.

**Symptom**: A new release PR exists but its body only contains the release-please auto-generated changelog, missing the `<!-- custom-release-notes:start -->` block with aggregated fragments.

**Fix**: Manually aggregate fragments into the release PR body:
```powershell
# Read the current PR body
$prBody = (gh pr view <number> --json body | ConvertFrom-Json).body

# Read the pending fragment(s)
$fragment = Get-Content docs/releases/pending/<slug>.md -Raw

# Append to PR body
$newBody = "$prBody`n`n---`n`n$fragment"
$newBody | Out-File "$env:TEMP\pr_body_update.txt" -Encoding UTF8
gh pr edit <number> --body-file "$env:TEMP\pr_body_update.txt"
```

Also update the GitHub Release body for the just-created release (append, don't replace):
```powershell
$existingNotes = (gh release view v7.X.Y --json body | ConvertFrom-Json).body
$fragment = Get-Content docs/releases/pending/<slug>.md -Raw
$combined = "$existingNotes`n`n---`n`n$fragment"
$combined | Out-File "$env:TEMP\release_notes_update.txt" -Encoding UTF8
gh release edit v7.X.Y --notes-file "$env:TEMP\release_notes_update.txt"
```

**PowerShell note**: `gh` CLI `--jq` expressions containing `$` (e.g. `--jq '.[] | .id'`) fail in PowerShell because `$` is interpreted as a variable prefix. Use `--json` output piped to `ConvertFrom-Json` instead. Note that `--notes "$(Get-Content ...)"` also has the same `$` expansion risk — always use `--body-file` / `--notes-file` with `Out-File` for multiline content.

### Troubleshooting — CI fails on tests that seem unrelated to your changes

If a test fails and you suspect it is pre-existing (unrelated to your changes):

1. **Confirm on a clean main checkout** using a disposable Git worktree:
   ```bash
   git worktree add /tmp/repro-check origin/main
   bun --smol test /tmp/repro-check/<path-to-failing-test> --timeout 30000
   git worktree remove /tmp/repro-check
   ```
   This avoids the risks of `git stash` (lost state, untracked files, locked files on Windows).

2. **If it also fails on main**: note the failure and its test file name in the PR description under `## Pre-existing failures`. Do NOT skip the other test tiers — a pre-existing failure in one tier does not exempt you from running the others. The PR will be evaluated on net change; pre-existing failures are flagged separately.

3. **If it only fails on your branch**: the failure was introduced by your changes. Fix it before proceeding.

### Step 6 — SHA-pin any workflow changes

If you add or modify any file in `.github/workflows/`, every `uses:` reference to a third-party action must be pinned to a full 40-character commit SHA with the version as a comment:

```yaml
# Correct
- uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4

# Wrong — will fail security tests
- uses: actions/checkout@v4
- uses: actions/checkout@main
```

Find the SHA for a tag:
```bash
gh api repos/{owner}/{repo}/git/ref/tags/{tag} --jq '.object.sha'
```

### Step 7 — Squash to a single clean commit

Before pushing, collapse all interim commits into one. The PR must land as a single commit whose message is the canonical record of the change.

**Before squashing, verify no tool or IDE files were accidentally staged:**
```bash
git diff --name-only HEAD origin/main | grep -E '\.(local\.json|vscode|idea)' || true
# Look for: .claude/settings.local.json, .vscode/, .idea/, etc.
# If any appear, remove them: git checkout origin/main -- <path>
```
These files are modified by Claude Code and IDEs during a session but must never be committed.

```bash
# Fetch main to ensure origin/main is current (CI may have merged main into your branch)
git fetch origin main

# See what you're about to squash (sanity check)
git log --oneline origin/main..HEAD

# Squash everything relative to current main
# Using origin/main instead of git merge-base HEAD main is important because
# CI may have auto-merged main into your branch, creating a merge commit
# that would confuse merge-base.
git reset --soft origin/main
git commit -m "type(scope): description"

# Force-push with lease (never plain --force)
git push --force-with-lease -u origin <branch-name>
```

**Rules:**
- The squash commit message must match the PR title exactly — they are the same thing.
- Use `--force-with-lease`, never `--force`. Lease rejects the push if the remote has commits you haven't seen.
- If a review cycle is already in progress (reviewer comments reference specific commit SHAs), do **not** squash until all review threads are resolved — squashing rewrites history and orphans inline comments.
- Any dist/ build artifact commits must be included in the squash (stage them before `git commit`).

**Why:** Interim commits (`fix attempt 1`, `wip`, `address review`) are noise in the project history. A single well-named commit makes `git log`, `git bisect`, and release notes meaningful. The PR title doubles as the squash commit message — both must be correct conventional-commit format.

#### Pushing to a PR branch owned by another agent or bot

When a PR was created by Copilot, another agent, or an automated tool, its head branch (e.g. `copilot/fix-skills-passing-to-subagents`) will not exist in your local repo. Pushing your local branch to a different remote name will create a second branch and leave the PR pointing at the wrong one. Correct pattern:

```bash
# 1. Identify the PR's actual head branch
gh pr view <number> --json headRefName --jq '.headRefName'
# e.g. → copilot/fix-skills-passing-to-subagents

# 2. Fetch it so git knows the remote ref
git fetch origin copilot/fix-skills-passing-to-subagents

# 3. Push your local branch to the PR's remote branch
git push origin <your-local-branch>:copilot/fix-skills-passing-to-subagents --force-with-lease
```

```powershell
# PowerShell equivalent
$prBranch = gh pr view <number> --json headRefName --jq '.headRefName'
git fetch origin $prBranch
git push origin "<your-local-branch>:$prBranch" --force-with-lease
```

Verify the PR is now tracking your commit: `gh pr view <number> --json headRefOid` should match `git rev-parse HEAD`.

### Step 8 — Open the PR with the correct body format

`## Summary` must have 1–3 bullets explaining what and why. `## Test plan` must be a markdown checklist. Do not replace the body of an existing release-please PR — prepend only.

**PR body MUST include `Closes #<issue-number>` as the first line** when the PR resolves a specific issue. This auto-closes the issue on merge. For PRs that don't close an issue, skip this line.

**After opening the PR, comment on the issue** with a summary of what changed, so issue subscribers get notified. Use `gh issue comment <number> --body "..."`.

#### bash (Linux / macOS)

```bash
# Include the Closes line only when the PR resolves an issue
gh pr create --title "<type>(<scope>): <description>" --body "$(cat <<'EOF'
Closes #<issue-number>

## Summary
- <bullet 1>
- <bullet 2 if needed>
- <bullet 3 if needed>

## Test plan
- [ ] <what you tested>
- [ ] <additional test step>

## Pre-existing failures
- <test name> — <reason> (if any pre-existing failures exist)
EOF
)" --base main

# After creating the PR, comment on the issue with a summary of changes
gh issue comment <issue-number> --body "Fixed in PR #<pr-number>. <bullet summary of changes>"
```

#### PowerShell (Windows)

`<<'EOF'` heredoc syntax is **invalid in PowerShell** and will produce a parse error. Use a here-string written to a temp file instead:

```powershell
# Include the Closes line only when the PR resolves an issue
$body = @"
Closes #<issue-number>

## Summary
- <bullet 1>
- <bullet 2 if needed>
- <bullet 3 if needed>

## Test plan
- [ ] <what you tested>
- [ ] <additional test step>

## Pre-existing failures
- <test name> — <reason> (if any pre-existing failures exist)
"@
$body | Out-File "$env:TEMP\pr_body.txt" -Encoding UTF8
gh pr create --title "<type>(<scope>): <description>" --body-file "$env:TEMP\pr_body.txt" --base main

# After creating the PR, comment on the issue with a summary of changes
gh issue comment <issue-number> --body "Fixed in PR #<pr-number>. <bullet summary of changes>"
```

Note: Inside a PowerShell here-string (`@"..."@`), backticks are literal — no escaping needed. Double-quotes inside the here-string do not need escaping either.

### Step 9 — Pre-merge checklist

Verify every item before asking for a merge:
- [ ] Step −1 invariant audit completed; `## Invariant audit` section present in the PR body in the format from `AGENTS.md`
- [ ] If the audit lists invariants 1, 2, or 3 as touched: `bun run build`, `node scripts/repro-704.mjs`, and `node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"` all ran cleanly with output in context
- [ ] If invariant 3 (subprocesses) is touched: every `bunSpawn` / `spawn` / `spawnSync` call in changed files passes `cwd` (or `git -C <directory>` for Git CLI calls), `stdin: 'ignore'`, `timeout`, bounded stdio, and `proc.kill()` in `finally`
- [ ] `test_runner` was NOT used with `scope: 'all'` or broad `'graph'` / `'impact'` scope to validate this repo (use shell commands instead)
- [ ] Branch has exactly **one commit** — the squashed commit from Step 7 (`git log --oneline origin/main..HEAD` shows one line)
- [ ] That commit message matches the PR title exactly, and both follow `<type>(<scope>): <description>`
- [ ] `docs/releases/pending/<unique-slug>.md` exists with meaningful release notes (NOT a `docs/releases/vX.Y.Z.md` file)
- [ ] `package.json` version, `CHANGELOG.md`, `.release-please-manifest.json` are untouched
- [ ] All 5 test tiers from Step 5 were actually run (not assumed — you must have the output in context), including `bunx biome ci .` on the full project (not scoped)
- [ ] If the repo tracks `dist/` files: `bun run build` was run and dist/ artifacts are included in the squash commit
- [ ] All workflow `uses:` references are SHA-pinned (if workflows changed)
- [ ] PR body has `## Summary`, `## Invariant audit`, and `## Test plan`
- [ ] If the PR resolves an issue: PR body starts with `Closes #<number>` (first line) and an `gh issue comment` was posted summarizing the change
- [ ] All CI checks are green before merging
