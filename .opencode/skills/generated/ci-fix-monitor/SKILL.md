---
name: ci-fix-monitor
description: >
  Monitor CI on a PR, diagnose failures, fix them, and re-push until green.
  Covers reading CI logs, classifying failure types (check-title, package-check,
  test failures, lint), determining the correct fix, and re-pushing.
effort: small
generated_from_knowledge: []
source_knowledge_ids: ['35eefd00-6f79-495b-8b86-8b95ba9800ce']
generated_at: 2026-06-14T16:50:00Z
confidence: 0.8
status: active
version: 3
skill_origin: generated
provenance_note: >
  Source knowledge ID backfilled from a new swarm knowledge entry capturing this skill's core lesson.
  Metadata and body preserved; version bumped to reflect provenance update.
---

# CI Fix & Monitor Protocol

Activates when the user asks to monitor CI, fix CI failures, or resolve red
checks on a PR.

## Environment note — tool availability

This skill was originally written for desktop Claude Code (Windows) with `gh`
CLI. In the **remote execution / GitHub MCP** environment, use the equivalent
MCP tools instead:

| Desktop / `gh` CLI | Remote MCP equivalent |
|---|---|
| `gh pr checks <number>` | `mcp__github__pull_request_read` method `get_check_runs` |
| `gh run view <run-id> --job <job-id> --log` | `mcp__github__get_job_logs` with `job_id` and `return_content: true` |
| `gh pr edit --title` | `mcp__github__update_pull_request` with `title` |
| `gh pr view --json mergeable` | `mcp__github__pull_request_read` method `get` |

> MCP tool names are injected by the runtime harness and not guaranteed to be
> stable across environments. Use `ToolSearch` to verify availability before
> calling any `mcp__github__*` tool for the first time in a session.

## Step 1 — Fetch current status

Fetch all check runs for the PR head commit. If all green: report success
and stop.

## Step 2 — Classify each failure

| Failure type | Root cause pattern | Fix action |
|---|---|---|
| **check-title** | PR title lacks `<type>(<scope>):` prefix | Update title via PR edit |
| **package-check** | npm tarball validation failed (source/build/package-manifest problem) | Fix source/build/manifest — see section below. Not generated-file drift. |
| **branch behind main** | Branch is behind main; main had a release commit; CI uses merge-commit checkout | Rebase onto main, force-push — see section below |
| **lint/quality: format** | Code style violations (long lines, spacing) | `bunx biome format --write <files>` then commit |
| **lint/quality: lint** | Lint rule violations (noExplicitAny, etc.) | `bunx biome check --write <files>` or fix manually |
| **unit test** | Test failures | Read log, fix code, commit |
| **integration** | Integration failures | Read log, check if pre-existing on main |
| **security** | SAST/secret findings | Read log, fix or suppress with justification |
| **smoke** | Smoke test failures | Read log, check if environment-specific |

## Step 3 — Diagnose with logs

For every failed check, fetch the full log content. Fetch only the tail
(last 80–100 lines) unless the error is near the start.

Read the log carefully before concluding root cause. Distinguish between:
- a failure introduced by this PR,
- a pre-existing failure on `main` (verify by checking main's last CI run for
  the same check), and
- a failure caused by the CI environment or branch drift.

## Step 4 — Fix

### check-title
No commit needed. Update the PR title.

### package-check failure

`package-check` validates the npm tarball (`npm pack` + tarball contents). A
failure is a source/build/package-manifest problem, **not** generated-file
drift. `dist/` is generated and NOT committed — do not stage it. Run
`bun run build` locally only when you need the bundle to verify the failure:

```bash
bun run build
node --input-type=module -e "await import('./dist/index.js'); console.log('dist import OK')"
```

Fix the underlying source/build/`package.json` `files` manifest issue, then
commit the source fix (not `dist/`) and push.

### branch behind main (version drift)

**Identifying this case:** A version string differs (`version: "X.Y.Z"` changed
to a higher version) because main had a release commit after the branch was cut,
and GitHub Actions checks out the merge-commit for CI. Rebase onto main to pick
up the release commit.

**Fix:**

```bash
git fetch origin main
git rebase origin/main       # fast-forward the branch onto the release commit
# If the rebase halts with conflicts, run `git rebase --abort` and escalate
# to the user — do not attempt to resolve a conflicted rebase automatically.
git push --force-with-lease origin <branch>   # force-push is required after rebase
```

> `--force-with-lease` is safe here: it refuses to overwrite commits that
> appeared on the remote after your last fetch. After the rebase, the local
> branch has diverged from remote history — a regular push will be rejected.

### lint/quality: format violations

Biome format violations (line too long, spacing, bracket style) — these can
appear when a code change introduces a line that exceeds Biome's print-width.
Auto-fix only the changed files to minimize noise:

```bash
bunx biome format --write src/path/to/changed-file.ts
bun test src/path/to/changed-file.test.ts   # verify tests still pass after format
git add <files>
git commit -m "style: apply Biome formatting"
git push origin <branch>
```

> Do NOT run `bunx biome format --write .` on the entire repo unless instructed
> — this can introduce formatting changes in unrelated files and bloat the diff.

### lint/quality: lint rule violations

```bash
bunx biome check --write <specific-file>
# or fix manually if --write does not handle the rule
```

### integration failures

Check whether the same check failed on `main`'s last CI run before treating
it as PR-introduced. If pre-existing: document the finding and skip. If
introduced by this PR: collect the full failure log, the test name, and the
first error line, then delegate to a coder with that evidence.

### security (SAST/secret findings)

Fetch the full log. If it is a secret/credential finding: confirm the file
and line, remove or rotate the credential, and commit the fix. If it is a
SAST code-quality finding: collect the rule ID, file, and line, then
delegate to a coder. Do NOT suppress findings without an explicit
justification comment approved by the user.

### unit test / smoke failures
Delegate to coder with specific failure details (test name, assertion, first
error line). See execute skill.

## Step 5 — Push and monitor

After pushing, subscribe to PR activity (if in webhook/MCP context) and wait
for the next CI event rather than polling. Do not push a second time until the
CI result from the first push is confirmed.

If no CI event arrives after a reasonable wait (e.g., checks are still queued
and stalled), re-fetch check status manually via `get_check_runs` and report
the stall state to the user rather than waiting indefinitely.

## Step 6 — Verify all green

Do NOT declare victory until ALL required checks pass. A check in `skipped`
state is acceptable only if the same check was skipped on the base branch
(i.e. the workflow gates on a path filter). Confirm this explicitly.

## Anti-patterns

- Do NOT watch CI passively without diagnosing failures first
- Do NOT assume a failure is pre-existing without checking main
- Do NOT skip the reviewer when the fix involves code changes (not just title)
- Do NOT run `biome format --write .` on the whole repo for a single-file format fix
- Do NOT stage or commit `dist/` — it is generated and NOT committed; there is no committed-dist drift check
- After a rebase, a force-push is required and expected — do not try a regular push

## Source knowledge entries
- 3736ded4: Evidence summary must not contain verdict words
- b3553e79: dist/ is generated and not committed — branch-behind-main fixes are rebase-only (no dist rebuild/commit)
- b701eb40: Bash glob quoting bug pattern
- 2a1b020a: High-volume CI notices create noise
- ff557dc: Branch-behind-main (version drift) fix: rebase onto main + force-push (no dist rebuild/commit)
