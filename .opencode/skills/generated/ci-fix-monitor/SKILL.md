---
name: ci-fix-monitor
description: >
  Monitor CI on a PR, diagnose failures, fix them, and re-push until green.
  Covers reading CI logs, classifying failure types (check-title, dist-check,
  test failures, lint), determining the correct fix, and re-pushing.
---

# CI Fix & Monitor Protocol

Activates when the user asks to monitor CI, fix CI failures, or resolve red
checks on a PR.

## Step 1 — Fetch current status

```powershell
gh pr checks <number>
```

If all green: report success and stop.

## Step 2 — Classify each failure

| Failure type | Root cause pattern | Fix action |
|---|---|---|
| **check-title** | PR title lacks `<type>(<scope>):` prefix | `gh pr edit <number> --title "type(scope): description"` |
| **dist-check** | `dist/` version mismatch after merge | Rebuild: `bun install --frozen-lockfile --force && bun run build` then commit dist/ |
| **lint/quality** | Code style violations | `bunx biome check --write .` then commit |
| **unit test** | Test failures | Read log: `gh run view <run-id> --job <job-id> --log`, fix code, commit |
| **integration** | Integration failures | Read log, check if pre-existing on main |
| **security** | SAST/secret findings | Read log, fix or suppress with justification |
| **smoke** | Smoke test failures | Read log, check if environment-specific |

## Step 3 — Diagnose with logs

For every failed check, fetch the log:

```powershell
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs
```

If the run is still in progress, wait:

```powershell
Start-Sleep -Seconds 30; gh pr checks <number>
```

## Step 4 — Fix

### check-title
No commit needed. Just rename:

```powershell
gh pr edit <number> --title "test(config): description here"
```

### dist-check
Rebuild and commit:

```powershell
bun install --frozen-lockfile --force
bun run build
node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"
git add dist/
git commit -m "chore: rebuild dist to match package.json X.Y.Z"
```

> Note: On Windows, use PowerShell syntax — avoid `&&` which is not valid in PowerShell 5.1.

### Code failures (tests, lint)
Delegate to coder with specific failure details. See execute skill.

## Step 5 — Push and monitor

```powershell
git push origin <branch>
# Wait for CI to start
Start-Sleep -Seconds 15
gh pr checks <number> --watch
```

## Step 6 — Verify all green

Do NOT declare victory until ALL required checks pass. Windows runners are
typically the slowest (up to 10 minutes).

## Anti-patterns

- Do NOT watch CI passively without diagnosing failures first
- Do NOT assume a failure is pre-existing without checking main
- Do NOT skip the reviewer when the fix involves code changes (not just dist/title)
- dist-check failures are NEVER pre-existing — they are always a hard gate

## Source knowledge entries
- 3736ded4: Evidence summary must not contain verdict words
- b3553e79: Rebuild dist after merge bumps version
- b701eb40: Bash glob quoting bug pattern
- 2a1b020a: High-volume CI notices create noise
