---
name: swarm-pr-feedback
description: >
  Ingest and resolve known pull request feedback with skeptical source verification.
  Use when addressing pasted PR feedback, GitHub review comments or threads,
  requested changes, CI/check failures, merge conflicts, stale PR branches, or
  PR follow-up work that must close all known issues without dropping findings.
  Supports multi-round bot reviews (the repository's bot posts a new review
  after every push) via the iterative pattern documented in the body.
---

# Swarm PR Feedback

Use this skill to close known PR feedback. This is not a fresh broad PR review.
`swarm-pr-review` discovers new findings; `swarm-pr-feedback` ingests existing
feedback surfaces, verifies each claim, clusters related problems, fixes confirmed
issues, validates the branch, and reports closure status for every item.

## Multi-Round Bot Reviews (Iterative Pattern)

The repository's bot reviewer (`hermes-pr-review` / Qwen3.6 + Gemma-4 dual-model)
posts a new review comment after **every push** to the PR branch, not just the
final state. Expect N rounds of review for N pushes, and budget for it.

**Round N+1 deltas vs Round N:**
- Fresh `FB-###` ledger IDs for new findings (do not reuse IDs from earlier rounds)
- Findings from prior rounds that remain unfixed will reappear with the same evidence
- Findings you marked DISPROVED with new evidence may reappear if the bot disagrees
- New findings may be introduced that the prior round did not see (the bot's read scope
  is the new commit, not the full diff history)

**Operating principles for multi-round triage:**

1. **Continue the ledger, do not start over.** Append to the same `FB-###` counter
   across rounds. Track each finding's state per round (open, fixed, disproved,
   awaiting-decision, repeated).
2. **Carry forward unresolved items.** Findings you marked `PARTIAL` or `NEEDS_USER_DECISION`
   in round N will still be open in round N+1. The closure ledger should show their
   evolution (e.g., "PARTIAL round 1 → CONFIRMED round 2 after evidence collected").
3. **Apply the 3-strikes-then-defense-in-depth rule.** When the same finding is
   raised 3+ times across rounds, prefer to add the suggested code change with a
   defense-in-depth rationale comment rather than continue to debate. One extra
   condition is cheap; per-round debate is expensive. Document the parent-vs-inner
   relationship inline so future readers see the rationale.
   **When not to apply 3-strikes:** If the suggested fix would add incorrect,
   misleading, or redundant code — e.g., an outer guard that already exists at an
   inner scope and whose addition would imply the inner guard is absent, a type
   narrowing that masks a real error class, or a check whose presence asserts a
   false invariant — do not add the change. A wrong fix embedded in the code is
   harder to remove than a repeated rebuttal in a comment thread. Apply item 6's
   "surface to user" path instead, with the cumulative evidence that the fix
   direction is incorrect.
4. **Verify bot fix-direction suggestions against actual file structure.** Bots
   read files linearly and can miss parent-block guards. For any "add an X check"
   suggestion, read the surrounding function/block to confirm the check is genuinely
   missing or already exists at a higher scope.
5. **Each round produces its own closure ledger as a PR comment.** Prefix with
   "Round N" so the bot and reviewers can see progression. Maintain a running
   summary table at the end of each comment showing totals across rounds
   (confirmed+fixed / disproved / partial / awaiting-decision).
6. **Stop the cycle deliberately.** If a finding is disproved with code evidence 3+
   times and the bot keeps re-raising it, leave the comment, post the closure
   ledger with the cumulative evidence, and surface the disagreement to the user
   rather than continuing to push fixes. The user can resolve persistent
   reviewer-AI disagreement.

**Why this matters:** Without the multi-round pattern, each round looks like
"start over, re-triage everything." With it, the rounds become incremental:
each round's work is bounded by new findings + carried-forward items only.
This matches how the bot actually behaves and avoids wasted cycles.

### Bot Review Verification Traps

When a bot or pasted review cites a code fact, verify the fact against the
current branch before editing:

- **Import/export claims:** Check the exact import path used by the changed file.
  A symbol may be missing from an internal submodule but correctly exported by the
  public barrel the tests or runtime actually import.
- **Line numbers:** Treat bot line references as approximate after any follow-up
  push or local edit. Re-locate the symbol or block with `rg` before patching.
- **Ordering claims:** If the concern is about rule precedence, add or run a
  direct precedence test that would fail under the wrong ordering; comments alone
  are not enough.
- **Disproved findings:** Do not change unrelated code to satisfy a false claim.
  Keep the finding in the closure ledger with the source or test evidence that
  disproves it.
- **Cache/state claims:** Test both relevant state orders when the behavior
  depends on cache priming, singleton state, or prior calls.

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

## Pre-flight: Check Out the PR Branch Locally

Before verifying any claim or making any fix, ensure the PR branch is the working
tree:

- If `head_ref` is a remote branch that is not checked out locally, fetch it
  (`git fetch origin <head_ref>`).
- **Check for parallel work first.** Before checkout, run the
  [`parallel-work-check`](../generated/parallel-work-check/SKILL.md) protocol to
  detect concurrent pushes from other agents (e.g., `hermes-pr-review` bot
  following up, maintainer pushing fixes, parallel swarm work). If remote has new
  commits: read `git log local..remote`, evaluate whether the parallel work
  supersedes your planned fixes, and prefer the parallel work if it's more
  comprehensive (more tests, better edge coverage, clearer error handling).
  Abort your rebase, take the remote state, then add minor improvements on top.
- Verify the working tree is clean first (`git status --porcelain`). If uncommitted
  changes exist, stash them or abort to prevent data loss.
- **Check out the head branch locally.** Feedback verification reads the working-tree
  filesystem (`Read`/`Glob`/`Grep`), and fixes must land on the PR branch — without a
  checkout you would verify and patch the base branch's code instead. Record the
  `base_ref..head_ref` range for diff-scoped inspection.
- If no PR reference was provided (a pasted-feedback session on the current branch),
  confirm the current branch is the intended PR branch before editing.

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
