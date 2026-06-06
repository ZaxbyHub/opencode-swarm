---
name: swarm-pr-feedback
description: >
  Ingest and resolve known pull request feedback with skeptical source verification.
  Use when addressing pasted PR feedback, GitHub review comments or threads,
  requested changes, CI/check failures, merge conflicts, stale PR branches, or
  PR follow-up work that must close all known issues without dropping findings.
---

# Swarm PR Feedback

Use this skill to close known PR feedback. This is not a fresh broad PR review.
`swarm-pr-review` discovers new findings; `swarm-pr-feedback` ingests existing
feedback surfaces, verifies each claim, clusters related problems, fixes confirmed
issues, validates the branch, and reports closure status for every item.

## Operating Stance

Treat every review comment, CI failure, bot summary, PR body claim, and pasted note
as a claim until source evidence proves it. Do not silently drop, defer, or mark
items out of scope. Ask the user only for product or scope decisions that cannot
be proven from the PR, repo, or explicit instructions.

Do not run a fresh broad PR review while addressing existing feedback. Inspect
adjacent code only as needed to verify reachability, dependencies, shared root
causes, regression risk, or sibling changes required by a confirmed item.

GitHub review-thread resolution is user-controlled. Do not resolve or mark review
threads resolved unless the user explicitly instructs you to do so.

## Intake Surfaces

Build a complete feedback ledger before editing. Include every available source:

- pasted user or reviewer feedback,
- GitHub review threads, inline review comments, and review summaries,
- PR issue comments and requested-changes reviews,
- CI/check failures, check annotations, and relevant logs,
- mergeability, conflicts, base drift, and stale PR branch state,
- local validation failures,
- PR body checkboxes, test-plan claims, linked issues, and acceptance criteria,
- commit history and bot/app commits on the PR branch.

If a source is unavailable, record that limitation. Do not treat missing access as
evidence that no feedback exists.

## Feedback Ledger

Normalize each item before triage:

```text
FB-001 | source | author/tool | status: UNTRIAGED | location | claim | raw link/quote | depends_on
```

Rules:

- Preserve exact reviewer wording or log summary when practical.
- Split compound comments into separate ledger items only when they require
  different evidence or fixes.
- Keep duplicate symptoms linked to one root cause rather than deleting them.
- Include conflicts, stale branch state, obsolete older-head CI,
  generated-output (`dist/`) drift, and other CI failures as first-class ledger
  items.
- Use explicit IDs for non-review feedback when useful, for example
  `CONFLICT-001` for merge/base drift and `CI-001` for check failures, so PR
  bodies can show exactly how operational blockers were closed.

## Verification

Classify every ledger item before fixing:

| Status | Meaning |
|---|---|
| `CONFIRMED` | The issue is real, reachable or structurally proven, and introduced or exposed by the PR. |
| `PARTIAL` | The comment points at a real concern, but the framing, severity, or requested fix is incomplete. |
| `DISPROVED` | Source, tests, or execution context prove the claim is false, unreachable, or already mitigated. |
| `PRE_EXISTING` | The issue exists on the base branch and is not materially worsened by the PR. |
| `NEEDS_USER_DECISION` | The item requires a product, UX, compatibility, or scope choice that cannot be inferred. |

Verification checklist:

- Read the referenced file and surrounding code.
- Check caller context, reachability, feature flags, schema validation, guards,
  state-machine rules, and permission boundaries.
- Determine whether the issue is PR-introduced, pre-existing, or unresolved.
- Check related tests and whether a failing/proposed test would prove the item.
- Check whether multiple feedback items share one root cause.

## Fix Planning

Cluster ledger items by root cause before coding. Fix in this order unless a user
instruction or dependency requires otherwise:

1. Merge conflicts, stale branch state, and base drift.
2. Deterministic CI, build, typecheck, formatting, and test failures.
3. Confirmed correctness, security, data-loss, persistence, git/write-safety, and
   permission issues.
4. Test gaps needed to prove confirmed fixes.
5. Docs, release notes, PR body, and migration guidance.
6. Reviewer communication and closure summaries.

For each cluster, record:

```text
ROOT-001 | ledger items: FB-001, FB-004 | files | fix approach | tests | docs | risk
```

Do not make scope decisions yourself. If the right fix depends on product intent
or compatibility policy, mark the item `NEEDS_USER_DECISION` and ask.

## Implementation Rules

- Patch only confirmed or partial items, plus required tests/docs.
- Do not implement speculative cleanup while feedback remains unclosed.
- Never ship unwired code. Any new command, tool, skill, config, docs surface, or
  generated artifact must be fully registered and validated.
- Never defer work or declare it out of scope without explicit user instruction.
- Keep invalid or disproved findings in the closure ledger with the evidence.
- For CI failures, verify the failing job belongs to the current PR head before
  treating it as current evidence.
- For generated output or dist failures, inspect the failing log before rebuilding
  and commit regenerated files only when the PR touches the source surface.
- When `main` has a merge queue enabled, do not rebase or force-push a PR only
  because `main` advanced. Once required checks and review are green, queue the PR
  and let the merge queue perform final current-base validation. Still resolve real
  merge conflicts and SHA-dependent review threads before queuing.

## Validation

Run targeted validation for every changed surface:

- exact failing CI/test command when reproducing a failure,
- tests for changed behavior or newly covered gaps,
- lint/format/typecheck/build where relevant,
- `git diff --check`,
- PR metadata checks after push: head SHA, check status, mergeability/conflicts,
  and unresolved feedback state.
- After conflict fixes, verify remote mergeability is clean (`MERGEABLE` /
  `CLEAN`), not only that local conflict markers disappeared.
- For current-head CI, prefer run-level details when PR checks look stale:
  `gh run view <run-id> --json headSha,status,conclusion,jobs,url`.

If a validation failure is suspected pre-existing, prove it on the base branch or
label it `UNVERIFIED`. Do not call the branch green while required checks are
non-green.

## Publishing And Communication

After fixes, update the PR body or comment with a closure ledger:

```text
FB-001 | fixed | commit/test evidence
FB-002 | disproved | code evidence
FB-003 | pre-existing | base-branch evidence
FB-004 | needs user decision | decision required
CONFLICT-001 | fixed | remote mergeability is MERGEABLE/CLEAN
CI-001 | fixed | current-head check/run evidence
```

Do not resolve GitHub review threads unless explicitly instructed. If instructed,
resolve only threads whose ledger item is fixed or disproved on the pushed PR
head, and record the exact evidence used.

## Final Output

Report:

- intake sources checked and unavailable sources,
- ledger counts by status,
- root-cause clusters fixed,
- tests and commands run,
- unresolved user decisions,
- CI/mergeability state,
- whether review-thread resolution was skipped or explicitly performed.

End with a complete ledger mapping every original item to its outcome.
