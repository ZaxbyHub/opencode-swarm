---
name: pr-readiness
description: >
  Complete pre-merge checklist for opencode-swarm PRs. Covers lint, build,
  tests, security scans, CI verification, release fragments, invariant audit,
  PR body claim verification, placeholder cleanup, review state, and merge
  conflict detection.
effort: small
generated_from_knowledge: []
source_knowledge_ids: ['f07c1f4d-9bb0-4219-9804-26aa8efe8146', '20f7da40-02e0-4da8-9310-a78eb87ca81e']
generated_at: 2026-06-14T16:50:00Z
confidence: 0.8
status: active
version: 4
skill_origin: generated
provenance_note: >
  Re-linked to current knowledge entries (version 4). The original source ID
  1bed6ebf... is no longer present in the active knowledge store. The skill
  body and behavior are unchanged; only source_knowledge_ids metadata was
  updated to point to current lessons about verifying pre-existing state on
  parent commit and updating test data after fixes, both directly relevant
  to the PR readiness pre-merge checklist.
---

# PR Readiness Skill

Activates when the user asks to verify PR readiness, run a pre-merge check,
or confirm a PR is safe to merge.

## When to Use

- Before opening a pull request for the first time
- Before merging an open PR
- When asked "is this PR ready to merge?" or "pre-merge checklist"
- After addressing review feedback — re-run this checklist before merging

## Pre-Merge Checklist

Run each item in order. A PR is not merge-ready until every item passes.

### 1. Lint pass

Run the `lint` tool with `mode="check"`. Must report 0 errors.

```
Tool: lint  |  mode: "check"
Expected: success, 0 errors
```

If lint fails, run with `mode="fix"` to auto-correct, then re-check.

### 2. Build pass

Run `build_check` to verify the project compiles without errors.

```
Tool: build_check  |  mode: "both"
Expected: success (both build and typecheck pass)
```

### 3. Test pass

Run tests for changed files only. Use `test_runner` with `scope="convention"`
and explicit `files: [...]`, or use the per-file shell isolation loop documented
in `TESTING.md`.

```
Tool: test_runner  |  scope: "convention"  |  files: <changed files>
Expected: success, 0 failures
```

Do NOT use `scope: "all"` for interactive validation. See AGENTS.md invariant 6.

### 4. Pre-check batch green

Run `pre_check_batch` on the project directory. All gates must pass
(`gates_passed: true`).

```
Tool: pre_check_batch  |  directory: <project root>
Expected: gates_passed === true
```

This runs lint, secretscan, SAST, and quality budget in a single pass.

### 5. CI green via `gh` CLI

Verify all remote CI checks are green on the PR head commit.

```bash
gh pr checks <PR_NUMBER>
```

Also inspect the structured check rollup:

```bash
gh pr view <PR_NUMBER> --json statusCheckRollup
```

All entries in `statusCheckRollup` must have `"status": "completed"` and
`"conclusion": "success"`. If any check is `"conclusion": "failure"`,
diagnose before proceeding.

### 6. Release fragment present

Every user-visible PR must ship a release note fragment under
`docs/releases/pending/`. Verify one exists for this change.

```bash
ls docs/releases/pending/
```

Each fragment is a `<unique-slug>.md` file. Do NOT create version-numbered
files — release-please owns the version number. See AGENTS.md invariant 12
and `contributing.md`.

### 7. Invariant audit section in PR description

The PR description must contain a `## Invariant audit` section covering all
12 invariants. See the [Invariant Audit Template](#invariant-audit-template)
section below.

For each invariant the PR touches, evidence must be a concrete artifact:
a command output, a passing test, a grep result, or a spec citation.
"Looks fine" is not evidence.

### 8. PR body claim verification

Verify that all quantitative claims in the PR description match the actual
source code. Bot reviews (Codex, Copilot) and human reviewers trust PR body
text — inaccurate claims waste review cycles and erode trust.

Check these claim types against source:

- **Test count**: Count actual test cases from test runner output or grep for
  test declarations only (not `describe` blocks):
  `grep -rE "^\s*(it|test)\(" --include="*.test.ts" | wc -l`
  Compare to PR body count.
- **Pattern/validation count**: If PR claims "12 regex patterns" or "3 validation
  gates", count the actual constants/patterns in the source file.
- **Storage format**: If PR claims "individual JSON files" or "JSONL", verify
  the actual store implementation reads/writes that format.
- **Tool count**: If PR claims "7 new tools", verify 7 tool files exist with
  `src/tools/` entries.
- **Config field names**: If PR shows config examples, verify field names match
  the Zod schema in `src/config/schema.ts`.

```bash
# Quick verification commands
grep -rE "^\s*(it|test)\(" tests/unit/tools/my-feature*.test.ts | wc -l   # actual test count
grep -c "PATTERN = " src/services/my-validator.ts                          # actual pattern count
ls src/tools/my-feature-*.ts | wc -l                                       # actual tool count
```

If any claim is inaccurate, fix the PR body before proceeding. Do not merge
with incorrect claims.

### 9. No TODOs or placeholder code

Run `placeholder_scan` or `todo_extract` on changed files.

```
Tool: placeholder_scan  |  changed_files: <changed files>
Expected: 0 findings (TODOs referencing a future task ID are acceptable)
```

Alternatively:

```
Tool: todo_extract  |  paths: <changed files or directory>
Expected: no stale TODOs/FIXMEs/HACKs
```

### 10. Secret scan clean

Run `secretscan` to verify no leaked credentials.

```
Tool: secretscan  |  directory: <project root>
Expected: 0 findings
```

If findings appear, verify they are false positives before suppressing.

### 11. SAST scan clean

Run `sast_scan` to verify no security vulnerabilities.

```
Tool: sast_scan  |  directory: <project root>
Expected: no medium+ severity findings
```

### 12. Review state

All required reviews must be approved.

```bash
gh pr view <PR_NUMBER> --json reviewDecision,latestReviews
```

`reviewDecision` summarizes the overall review outcome. It should be
`"APPROVED"` to proceed. Historical `COMMENTED` or `DISMISSED` reviews
do not block merge — only an unresolved `"CHANGES_REQUESTED"` in
`latestReviews` will block. If `reviewDecision` is `"CHANGES_REQUESTED"`
or `"REVIEW_REQUIRED"`, address the outstanding feedback before merging.

### 13. No merge conflicts

```bash
gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus
```

Must return `"mergeable": "MERGEABLE"` and `"mergeStateStatus": "CLEAN"`.
If `"mergeable"` is `"UNKNOWN"`, wait for GitHub to recalculate mergeability, then re-check.
If `mergeStateStatus` is `"BEHIND"`, the PR needs a rebase.
If it is `"DIRTY"` or `"BLOCKED"`, resolve conflicts or blockers before merging.

## Quick Commands

Reference set of `gh` CLI commands for CI and review status:

```bash
# Check CI status
gh pr checks <PR_NUMBER>

# Structured check rollup
gh pr view <PR_NUMBER> --json statusCheckRollup

# Review state
gh pr view <PR_NUMBER> --json reviewDecision,latestReviews

# Merge conflicts
gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus

# List pending release fragments
ls docs/releases/pending/

# Combined status view
gh pr view <PR_NUMBER> --json title,state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,latestReviews
```

## Invariant Audit Template

Every PR description must include this section. For each invariant, mark it
`touched` or `not touched`, and provide concrete evidence for any `touched`
entry.

```markdown
## Invariant audit
- 1 (plugin init):       touched / not touched — <evidence>
- 2 (runtime portability): touched / not touched — <evidence>
- 3 (subprocesses):       touched / not touched — <evidence>
- 4 (.swarm containment): touched / not touched — <evidence>
- 5 (plan durability):    touched / not touched — <evidence>
- 6 (test_runner safety): touched / not touched — <evidence>
- 7 (test writing):       touched / not touched — <evidence>
- 8 (session state):      touched / not touched — <evidence>
- 9 (guardrails/retry):   touched / not touched — <evidence>
- 10 (chat/system msg):   touched / not touched — <evidence>
- 11 (tool registration): touched / not touched — <evidence>
- 12 (release/cache):     touched / not touched — <evidence>
```

### Invariant summary (for quick reference)

| # | Invariant | Key trigger files |
|---|-----------|--------------------|
| 1 | Plugin init bounded, fail-open | `src/index.ts`, plugin entry, init hooks |
| 2 | Node-ESM-loadable, v1 plugin shape | `src/index.ts`, `package.json#main`, `dist/`, `bun build` config |
| 3 | Subprocesses bounded, killable | Any `spawn`/`spawnSync`/`bunSpawn` call |
| 4 | `.swarm/` containment | Any tool or hook creating files outside `.swarm/` |
| 5 | Plan ledger authoritative | `plan-ledger.jsonl`, plan schema/status changes |
| 6 | No broad `test_runner` | `test_runner` tool calls with `scope: "all"` |
| 7 | bun:test, mock isolation | Any test file creation or modification |
| 8 | Session state keyed by sessionID | Maps/arrays keyed by session in hooks or tools |
| 9 | Transient retry vs real failure | Guardrail, retry, circuit-breaker code |
| 10 | Chat/system message shape | System message hook code |
| 11 | Tool registration + agent-map coherence | `src/tools/index.ts`, `src/index.ts` plugin block, `src/config/constants.ts` |
| 12 | Release/cache hygiene | `package.json#version`, `CHANGELOG.md`, cache-deletion code, release fragments |

## Common Failures

### dist/ not rebuilt after source change

Symptom: `dist-check` CI job fails with "source changed but dist/ not rebuilt".
Fix: Run `bun run build` locally to verify the bundle, but do NOT commit `dist/` — it is generated and NOT committed. Push the source fix only.

### Version drift on stale branch

Symptom: `dist-check` fails even after rebuilding — branch is behind `main`
and a release commit changed `package.json#version`.
Fix: Rebase onto `main`, rebuild dist, force-push. Do NOT hand-edit version
files — release-please owns them (invariant 12).

### Missing release fragment

Symptom: No file found in `docs/releases/pending/` for this change.
Fix: Create a `<unique-slug>.md` fragment describing the change.
Do NOT use version numbers in the filename.

### Lint auto-fix introduces unrelated changes

Symptom: `bunx biome format --write` or `bunx biome check --write` reformats
lines not part of the intended change.
Fix: Run lint fix on only the changed files, not the whole project. Review
the diff after fixing.

### mock.module leaks in tests

Symptom: Tests pass individually but fail when run as a suite.
Fix: Replace `mock.module` with the `_internals` DI seam pattern. See the
`mock-to-internals-migration` skill.

### test_runner scope exceeded

Symptom: `test_runner` returns `outcome: 'scope_exceeded'` with a SKIP
instruction.
Fix: Reduce scope — use explicit `files: [...]` or `scope: "convention"`.
Do not use `scope: "all"` interactively (invariant 6).

### Merge conflicts after rebase

Symptom: `gh pr view --json mergeable,mergeStateStatus` returns `false` or
`"DIRTY"` after rebasing.
Fix: Resolve conflicts locally, commit, push. Re-run this checklist from
step 1.

### PR body claims inaccurate

Symptom: Bot reviews (Codex/Copilot) flag test count, pattern count, or storage
format mismatches between PR body and source.
Fix: Count from actual source files, update PR body to match. Common
mismatches: test count inflation (counting `describe` blocks instead of `test`
calls), JSONL vs file-based store confusion, pattern count including auxiliary
checks that are not regex patterns.
Prevention: Run step 8 (claim verification) before opening the PR.
