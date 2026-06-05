---
name: running-tests
description: >
  Safe test execution patterns for opencode-swarm. Covers when to use the test_runner
  tool vs shell bun commands, scope safety rules, per-file isolation loops (bash and
  PowerShell), pre-existing failure verification, CI log reading, and failure
  classification. Load this skill when you need to run tests — not when you need to
  write them (see writing-tests for authoring guidance).
---

# Running Tests for opencode-swarm

This skill is about **executing** tests safely. For **writing** tests, see `writing-tests`.

---

## ⛔ The One Rule That Prevents Session Kills

**Never use `test_runner` with more than one source file for any discovery scope.**

`graph` and `impact` each fan out per file through the import tree; `convention` maps
each source file to a test file by name convention. The union quickly exceeds
`MAX_SAFE_TEST_FILES = 50`, triggering `scope_exceeded`, which causes LLMs to
cascade to `scope: 'all'` and kill the session. All three scopes now reject with
`scope_exceeded` before fan-out when `sourceFiles.length > MAX_SAFE_SOURCE_FILES = 1`.

---

## Three-Layer Defense Against Session Blocking

test_runner has three pre-resolution guards that prevent unbounded fan-out from blocking the session:

### Layer 1 — Source-file count guard (synchronous, fires before any I/O)
`sourceFiles.length > MAX_SAFE_SOURCE_FILES (1)` → returns `scope_exceeded` immediately. Catches the common case of multi-file calls before any filesystem access.

### Layer 2 — Pre-resolution fan-out estimate (fast, ~100ms)
`estimateFanOut(sourceFiles, workingDir)` reads the cached impact map and counts unique test files without spawning subprocesses. If the estimate exceeds `MAX_SAFE_TEST_FILES = 50`, the call returns `scope_exceeded` immediately — before any graph traversal begins. Only fires when `sourceFiles.length === 1` (Layer 1 has already passed).

### Layer 3 — Budget-limited traversal + post-resolution length check
`analyzeImpact` accepts a `budget` parameter (`MAX_SAFE_TEST_FILES = 50`). The traversal stops as soon as it has visited 50 test files and sets `budgetExceeded: true`. The call site checks this flag and returns `scope_exceeded` before processing results.
After graph resolution, the final `testFiles.length` is additionally compared to `MAX_SAFE_TEST_FILES`. If exceeded, `scope_exceeded` is returned.

**Result:** When fan-out exceeds the safe threshold, the session gets `outcome: 'scope_exceeded'` instead of hanging.

---

## Decision Tree: test_runner tool vs bun shell command

```
Do you need to run tests?
│
├─ Single test file, targeted validation
│   └─ Either works. Prefer shell: bun --smol test <file> --timeout 30000
│
├─ Multiple files in the same directory (e.g. all agents tests)
│   └─ Shell only — per-file loop. Never test_runner with multiple files.
│
├─ Find tests related to ONE changed source file
│   └─ test_runner is fine: { scope: 'graph', files: ['src/agents/coder.ts'] }
│      (single file → bounded fan-out)
│
├─ Find tests related to MULTIPLE changed source files
│   └─ Shell only — per-file loop over the changed files, or run the whole directory.
│      test_runner with any discovery scope + multiple source files = scope_exceeded
│      (guard fires before fan-out for convention, graph, and impact scopes).
│
└─ Validate the entire repo (pre-push)
    └─ Shell only — 5-tier suite from commit-pr skill. Never test_runner scope:'all'.
```

---

## Scope Safety Reference

| Scope | With `files: [one]` | With `files: [many]` | Notes |
|-------|--------------------|--------------------|-------|
| `'convention'` | ✅ Safe | ❌ Rejected (`scope_exceeded`) | Guard fires before fan-out; direct test file paths exempt |
| `'graph'` | ✅ Safe (capped at 50 via budget) | ❌ Rejected (`scope_exceeded`) | Two-layer guard: source-file count + fan-out estimate |
| `'impact'` | ✅ Safe (capped at 50 via budget) | ❌ Rejected (`scope_exceeded`) | Two-layer guard: source-file count + fan-out estimate |
| `'all'` | ❌ Never | ❌ Never | Requires `allow_full_suite: true`; CI mirror only |
| `'all'` | ❌ Never | ❌ Never | Requires `allow_full_suite: true`; CI mirror only |

**Rule of thumb:** Pass exactly one source file to `test_runner`. For multiple files, use a shell loop.

---

## Per-File Isolation Loops

CI runs agents/tools/services in per-file isolation (one `bun --smol` process per file).
Reproduce this locally with the following loops.

### bash (Linux / macOS)

```bash
# Single directory — per-file isolation
for f in tests/unit/agents/*.test.ts; do
  bun --smol test "$f" --timeout 30000
done

# Multiple directories
for dir in tests/unit/tools tests/unit/services tests/unit/agents; do
  for f in "$dir"/*.test.ts; do
    bun --smol test "$f" --timeout 30000
  done
done

# Stop on first failure (useful for debugging)
for f in tests/unit/agents/*.test.ts; do
  bun --smol test "$f" --timeout 30000 || { echo "FAILED: $f"; break; }
done
```

### PowerShell (Windows)

```powershell
# Single directory — per-file isolation
Get-ChildItem tests/unit/agents/*.test.ts | ForEach-Object {
  bun --smol test $_.FullName --timeout 30000
}

# Multiple directories
@('tests/unit/tools', 'tests/unit/services', 'tests/unit/agents') | ForEach-Object {
  Get-ChildItem "$_/*.test.ts" | ForEach-Object {
    bun --smol test $_.FullName --timeout 30000
  }
}

# Capture output (avoids truncation on large output)
Get-ChildItem tests/unit/agents/*.test.ts | ForEach-Object {
  bun --smol test $_.FullName --timeout 30000
} | Out-File "$env:TEMP\test_out.txt"
Get-Content "$env:TEMP\test_out.txt" | Select-Object -Last 50
```

**Common PowerShell pitfalls:**
- `for f in ...; do` — invalid, use `Get-ChildItem | ForEach-Object`
- `Select-String -Last N` — invalid parameter, use `Select-Object -Last N`
- `2>&1 2>&1` — duplicate redirection, causes parse error; use `2>&1` once
- `&&` — not supported in PowerShell 5.1; use `; if ($?) { cmd2 }` instead
- After `bun install --frozen-lockfile --force`, non-elevated Windows shells can hit `EPERM` while reading refreshed `node_modules` entries. Treat that as a host permission/access issue: rerun the same focused Bun command with approved/elevated access before diagnosing it as a code or test failure.

---

## Batch vs Per-File: Which Directories Need Isolation?

| Directory | Mode | Reason |
|-----------|------|--------|
| `tests/unit/tools/` | Per-file loop | Heavy `mock.module` usage; cache poisoning risk |
| `tests/unit/services/` | Per-file loop | Same |
| `tests/unit/agents/` | Per-file loop | Same |
| `tests/unit/hooks/` | Per-file loop | Same |
| `tests/unit/cli/` | Batch OK | Fewer mock conflicts |
| `tests/unit/commands/` | Batch OK | Fewer mock conflicts |
| `tests/unit/config/` | Batch OK | Fewer mock conflicts |
| `tests/integration/` | Batch OK | Integration fixtures, not mock-heavy |
| `tests/security/` | Batch OK | Adversarial inputs, no module mocks |
| `tests/smoke/` | Batch OK | Built-package tests |

---

## Truncated Output Recovery

When `bun test` output exceeds the bash tool's buffer, it is saved to a file with an ID
like `tool_dff778...`. This ID format is **not** accepted by `retrieve_summary` (which only
reads `S1`, `S2` etc. format IDs). The output is effectively lost.

**Prevention — pipe to a file explicitly:**

```powershell
# PowerShell
bun --smol test tests/unit/agents --timeout 60000 |
  Out-File "$env:TEMP\test_out.txt"
Get-Content "$env:TEMP\test_out.txt" | Select-Object -Last 50
```

```bash
# bash
bun --smol test tests/unit/agents --timeout 60000 2>&1 | tee /tmp/test_out.txt
tail -50 /tmp/test_out.txt
```

**To get a clean pass/fail summary only**, filter immediately:

```powershell
# PowerShell — show only summary lines
bun --smol test tests/unit/agents --timeout 60000 |
  Select-String "pass|fail|error" |
  Select-Object -Last 10
```

```bash
# bash
bun --smol test tests/unit/agents --timeout 60000 2>&1 | grep -E "pass|fail|error" | tail -10
```

---

## Verifying Pre-Existing Failures

Before documenting a failure as "pre-existing," prove it exists on `main` without affecting
your working tree. Use a Git worktree — safer than `git stash` (stash can drop untracked
files, fail on locked files on Windows, and leave you in an inconsistent state).

```bash
# bash — create a throwaway checkout of main
git worktree add /tmp/repro-check origin/main
bun --smol test /tmp/repro-check/tests/unit/agents/architect-workflow-security.test.ts --timeout 30000
git worktree remove /tmp/repro-check
```

```powershell
# PowerShell — same pattern (use Join-Path for robust separator handling)
git worktree add "$env:TEMP\repro-check" origin/main
$testPath = Join-Path "$env:TEMP\repro-check" "tests\unit\agents\architect-workflow-security.test.ts"
bun --smol test $testPath --timeout 30000
git worktree remove "$env:TEMP\repro-check"
```

**Decision after checking:**
- Fails on `main` too → pre-existing. Document under `## Pre-existing failures` in PR body. Continue.
- Fails only on your branch → you introduced it. Fix before pushing.

**⚠️ Check your own session history first.** Before documenting anything as pre-existing, confirm you did not fix or update this test earlier in the current session. A test you fixed 20 messages ago is not pre-existing — listing it as such in the table or PR body is incorrect and will be caught in review.

---

## Failure Classification

Not all failures are equal. Before deciding what to do, classify the failure:

| Class | Definition | Example | What to do |
|-------|-----------|---------|------------|
| **Stale assertion** | Test checks for text/value that was deliberately removed | `expect(prompt).toContain('CONSTRAINT: [what NOT to do]')` — template removed in refactor | Update the assertion to match current state |
| **Soft regression indicator** | Test checks a threshold the codebase has since exceeded | `expect(tokenCount).toBeLessThan(35000)` — prompt grew past limit | Fix the threshold or reduce the prompt; do not just document and ignore |
| **Genuine pre-existing** | Failure exists on `main` unrelated to any recent change | `full-auto-intercept.test.ts` logger gating issue | Document in PR body; do not fix unless scoped |
| **New regression** | Failure introduced by your changes | Tests for prompt text you removed without updating tests | Fix before pushing |

**Stale assertions and soft regression indicators are actionable** — they signal drift between
tests and code. Genuine pre-existing failures are not your responsibility to fix in this PR,
but they must be documented.

---

## Reading CI Failure Logs

When a CI job fails, the GitHub Actions log shows the exact `file:line` of the failure.
Do not guess — read the log.

```bash
# Get the failing job URL from the PR
gh pr view <number> --json statusCheckRollup --jq '.statusCheckRollup[] | select(.conclusion=="FAILURE") | .detailsUrl'

# Fetch and search the log (if gh CLI available)
gh run view --log <run-id> | grep -E "FAIL|error" | head -20
```

Or open the `detailsUrl` directly in a browser / via WebFetch and search for:
- `(fail)` — Bun test failure marker
- `error:` — parse or runtime error
- `at <anonymous>` — stack frame pointing to the test file and line

Once you have `tests/unit/agents/some-file.test.ts:354`, reproduce locally:
```bash
bun --smol test tests/unit/agents/some-file.test.ts --timeout 30000
```

---

## Quick Reference: Common Failures and Causes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `scope_exceeded` returned from test_runner | Fan-out exceeded 50 test files during graph/impact resolution | Switch to per-file shell loop; reduce changed-files scope |
| Session killed during test_runner | Pre-fix: unbounded fan-out on multiple files | Now returns `scope_exceeded` instead — no more session kills |
| `mock.module` breaks unrelated tests | Missing spread of real module exports | Add `...realModule` spread |
| Windows tests fail with EBUSY | `mock.restore()` called while child process holds lock | Add `test.skipIf(process.platform === 'win32')` |
| Test output truncated, ID unreadable | Bash tool buffer exceeded | Pipe to `Out-File`/`tee` explicitly |
| `for f in ...; do` parse error | Bash syntax in PowerShell | Use `Get-ChildItem | ForEach-Object` |
| `Select-String -Last N` error | Invalid PowerShell parameter | Use `Select-Object -Last N` |
| Token budget test failure | Prompt grew past hardcoded threshold | Treat as soft regression; update threshold |
| CONSTRAINT assertion fails after refactor | Test checks for removed format template | Update assertion to match current prompt |
| `package-check` CI failure | `package-check` validates the npm tarball (`npm pack` + tarball contents) — a source/build/package-manifest problem, not generated-file drift. `dist/` is generated and NOT committed — do not stage it; run `bun run build` locally only when you need the bundle. There is no longer a committed-dist drift check. |
