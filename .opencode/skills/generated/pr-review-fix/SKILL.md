---
name: pr-review-fix
description: >
  Apply when processing PR review feedback — addressing reviewer findings on an open pull request.
  Covers the full cycle: read review comments, validate findings against actual code, classify
  by file and severity, delegate fixes, update documentation, amend the commit, force-push,
  update the PR description, and monitor CI to green. Prevents blind fixes, over-scoped changes,
  and CI surprises.
effort: medium
---

# PR Review Fix Protocol

Follow every step in order. Do not skip steps. This skill assumes you already have an open PR with review comments.

## Step 0 — Read the review and normalize findings

1. Collect ALL review comments from the PR (inline comments, general comments, review summary).
2. Normalize each finding into a structured record:

```
FINDING-ID: C-01 (C=critical, S=security, T=test, W=wording, P=process)
SEVERITY: HIGH / MEDIUM / LOW
FILE: path/to/file.ts
LINE: 42
DESCRIPTION: What the reviewer flagged
EVIDENCE: Exact quote from the reviewer
```

3. Assign a sequential ID to each finding (C-01, C-02, ..., S-01, ..., T-01, ..., W-01, ..., P-01, ...).
4. Print the full findings table before proceeding.

**Gate:** Every finding must have an ID, severity, file, and exact quote. If any field is missing, go back and fill it.

## Step 1 — Validate findings against actual code (do NOT skip)

**Critical step.** Reviewers sometimes flag code that is correct, misread control flow, or cite issues that don't exist at the referenced line. Blindly fixing every finding wastes time and can introduce regressions.

For EACH finding:

1. Open the referenced file at the referenced line.
2. Read the surrounding context (at least 20 lines before and after).
3. Determine one of:
   - **VALID** — the finding is correct and the code needs a fix
   - **DOWNGRADE** — the finding is real but severity is lower than stated (e.g., HIGH → LOW)
   - **INVALID** — the finding is incorrect; the code is already correct
   - **NEEDS CONTEXT** — you cannot determine validity without asking the reviewer or user
4. Record the verdict next to the finding.

**Rules:**
- A finding is INVALID only if you can prove with code evidence that the reviewer's claim is wrong.
- "I think it's fine" is NOT a valid INVALID verdict. You need a specific code-level reason.
- When downgrading, record the original severity and the recommended severity with a one-line justification.
- Print the full validated findings table before proceeding.

## Step 2 — Classify findings by file and fix scope

Group findings by file, then determine fix scope for each group:

```
FILE: src/hooks/example.ts
FINDINGS: C-01 (VALID, HIGH), C-02 (DOWNGRADE→LOW)
FIX SCOPE: Single file, two changes
DEPENDENCIES: None (changes are independent)
```

For each group, answer:
- Does this fix require changes to other files? (imports, tests, types)
- Does this fix change any public API or exported interface?
- Does this fix require documentation updates (README, release notes)?

**Gate:** Every finding must be classified. Do not proceed with unclassified findings.

## Step 3 — Fix findings (one file group at a time)

For each file group:

1. Read the full file before making changes. Do not edit blindly at the flagged line.
2. Make the minimal fix that addresses the finding without introducing new behavior.
3. For DOWNGRADE findings: still fix them if the change is trivial. Skip only if the fix would be riskier than the finding.
4. For INVALID findings: do NOT touch the code. Add a comment to the PR thread explaining why.

**Anti-patterns — do NOT do these:**
- Fixing a finding by adding a comment that says "// this is fine" — fix the code or skip it.
- Batch-fixing all findings in one pass without reading each file individually.
- "While I'm here" changes — only fix what was flagged.
- Changing unrelated code to "improve" the area around the finding.
- Accepting coder edits to template literal strings (backtick-delimited `.ts` content) without verifying that internal backticks are escaped. Unescaped backticks cause `SyntaxError` at build time even when the text looks correct in Read output.

## Step 4 — Update tests

For each code fix:

1. If the fix changes behavior covered by existing tests: run those tests and verify they still pass.
2. If the fix changes behavior NOT covered by existing tests: write a new test proving the fix works.
3. If the fix is purely cosmetic (renaming, comment wording): no new test needed, but run the existing suite.

Run the relevant test files in isolation before proceeding to the full suite:

```bash
bun --smol test tests/unit/path/to/test.test.ts --timeout 30000
```

## Step 5 — Update documentation

Check if any fix requires documentation updates:

- **Release notes** (`docs/releases/pending/<slug>.md`): Add or update a pending fragment if the fix changes user-visible behavior, fixes a documented issue, or alters an API. Do NOT compute a next version or create `docs/releases/vX.Y.Z.md` — release-please owns the version, and `scripts/release-notes-fragments.mjs` aggregates pending fragments at release time. Pick a unique kebab-case slug.
- **README / guides**: Update if the fix changes installation steps, configuration options, or usage patterns.
- **Code comments**: Update if the fix invalidates an existing comment or makes a non-obvious behavior change.

## Step 6 — Commit the fixes

1. Stage ALL fix files (code + tests + docs). Do not stage unrelated changes.
   - Use explicit path staging to include new files (tests, docs) that `git add -u` would miss:
   ```bash
   git add src/path/to/changed-file.ts tests/unit/path/to/new-test.test.ts docs/releases/pending/your-fix-slug.md
   ```
2. If this is an amendment to the PR commit:

```bash
git commit --amend --no-edit
```

If the PR uses separate commits for fixes:

```bash
git commit -m "fix(pr-review): address findings C-01, C-02, T-01, W-01"
```

3. Verify the commit message follows conventional commit format.

## Step 7 — Pre-push validation

Before pushing, run local validation to catch formatting and style issues that CI would reject:

1. **Lint/format check**: Run the project's local linting tool on all modified files. This catches formatting-only issues without burning a CI cycle. On this project, check that any coder-written test files pass formatting validation.
2. **Build check**: Run the project build command to verify no syntax errors (especially important when coders modify template literal strings — unescaped backticks cause build failures).
3. Stage and commit.

## Step 8 — Push and update PR

```bash
# For amended commits:
git push --force-with-lease origin <branch>

# For new commits:
git push origin <branch>
```

Update the PR description to include a `## PR Review Fixes` section:

```markdown
## PR Review Fixes

Addressed N findings from PR review:

| ID | Severity | Verdict | Fix |
|----|----------|---------|-----|
| C-01 | HIGH | VALID | Fixed traversal check at line 121 |
| C-02 | MEDIUM | DOWNGRADE→LOW | Added warn() logging for empty catch |
| S-01 | HIGH | INVALID | Code already uses validated path resolution |
| T-01 | LOW | VALID | Added test for validated path resolution |
| W-01 | LOW | VALID | Corrected wording in release notes |

Skipped: none
```

## Step 9 — Monitor CI

1. Wait for CI to start.
2. **If a CI run appears stuck (queued >10 minutes)**: check for stale in-progress runs from prior pushes. Cancel them with `gh run cancel <run-id>` — GitHub Actions concurrency groups queue new runs behind in-progress ones.
3. If CI fails:
    - Read the failure log carefully.
    - Determine if the failure is caused by your fix or is a pre-existing issue.
    - If caused by your fix: return to Step 3 for that finding.
    - If caused by formatting/style: fix locally, rebuild, amend, and push again.
    - If pre-existing (infrastructure flake, unrelated test):
      a. Rerun the failed job once.
      b. If the rerun passes: the failure was infrastructure. Proceed.
      c. If the rerun fails the same way: this is a real pre-existing issue. Document it separately in the PR thread (do NOT mark CI as green). The PR author or maintainer must decide whether to merge with a known pre-existing failure or fix it first.
4. CI outcomes:
    - **Green (all checks pass)**: You're done.
    - **Pre-existing failure confirmed after rerun**: Document in PR, flag to maintainer. Do NOT claim CI is green.
    - **Blocked (job stuck/queued >30 min after cancellation)**: Re-trigger the workflow.

## Platform-specific notes

### PowerShell (Windows)

- `gh` CLI may split arguments on colons and parentheses. Use `-F` body-file flag for PR body content:

```powershell
$bodyContent = "PR body text here"
$tmpFile = Join-Path $env:TEMP "pr-body-$(Get-Random).txt"
try {
    $bodyContent | Out-File -FilePath $tmpFile -Encoding utf8
    gh pr edit $prNumber --body-file $tmpFile
} finally {
    if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force }
}
```

- Use variable-stored titles to avoid argument splitting:

```powershell
$title = "fix(skill-propagation): address PR review findings"
gh pr edit $prNumber --title $title
```

### CI timeout handling

- GitHub Actions Ubuntu runners may time out on long test runs (~20 minutes). This is typically an infrastructure issue, not a code problem.
- If a CI check times out: rerun the failed job once before investigating code changes.
- If the rerun passes in normal time (under 5 minutes), it was infrastructure.

## Decision log template

Track your validation decisions for auditability:

```markdown
## Finding Validation Log

| ID | Reviewer Severity | My Verdict | Justification |
|----|------------------|------------|---------------|
| C-01 | HIGH | VALID | Line 121 uses raw path.join without validation |
| C-02 | MEDIUM | DOWNGRADE→LOW | Empty catch is in a non-critical path; warn() is sufficient |
| S-01 | HIGH | INVALID | Line 246 already calls resolveLogPath() which uses validateSwarmPath() |
| T-01 | LOW | VALID | No existing test for validated path resolution in tail-read |
| W-01 | LOW | VALID | "auto-enriches" is inaccurate; should be "advises on skill selection" |
```
