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

When the work starts from a prior `swarm-pr-review` run, ingest the review's
handoff artifact (for example
`.swarm/pr-review/<run_id>/feedback-handoff.md` or `.json`) before triage.
Carry forward the original review finding IDs, classifications, reviewer/critic
provenance, and any operational blockers instead of renumbering them as new
discoveries.

Feedback closure is not the end of the PR lifecycle: when PR monitoring is
enabled (`pr_monitor.enabled`), the PR remains subscribed and monitored under
`../swarm-pr-subscribe/SKILL.md` until it is merged or closed. Events that
arrive after closure (a new bot round, a CI change, fresh review activity) are
triaged through that skill and route back into this discipline when they need
fixes.

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

Do not act on review-discovered findings from a prior `swarm-pr-review` run
unless the user has explicitly approved the transition into `swarm-pr-feedback`.
The handoff artifact is triage input, not standing authorization to change code.

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

When a verification lane result includes `output_ref`, treat `output` as a
preview and call `retrieve_lane_output` before using it to classify, resolve,
disprove, or group feedback items. If the result is `output_degraded`,
`transcript_incomplete`, or truncated without a usable ref, keep the affected
ledger items as `NEEDS_MORE_EVIDENCE` or re-dispatch a narrower read-only lane.

## Pre-flight: Dirty Worktree Handling

Before staging any files for the PR commit, check the working tree state:

**The problem:** `git add -A` stages every uncommitted change in the working tree,
including pre-existing changes from other branches or prior work. This was hit twice
in one session during PR #1472 review, producing a 59-file commit instead of the
intended 2-file targeted fix.

**The check:** Run `git status --porcelain` first. If output is non-empty, identify
which files are PR-related vs pre-existing uncommitted changes.

**The rule:** Stage files explicitly by path when the working tree contains files
unrelated to the PR. For example:

```bash
git add src/foo.ts tests/foo.test.ts
```

Never use `git add -A` when the working tree has pre-existing changes from other
branches or prior work sessions.

*Reference: Caught during PR #1472 Round 1 closure.*

## Pre-flight: Scope Discipline

`declare_scope({ taskId, files })` enforces that the delegated coder agent may only modify the declared files. The enforcement requires an active `.swarm/plan.json` — calling `declare_scope` in a feedback-closure run (which does not go through `save_plan`) rejects with "No plan found."

**When to use `declare_scope` (preferred):** any feedback round that touches 2+ files, OR any feedback round where the file scope is not 100% obvious from the prompt. Before delegating, save a minimal plan via `save_plan` with a single phase containing the feedback-closure tasks, then call `declare_scope` per task with the exact file list.

**Carve-out for direct Task delegation:** 1-file, single-function changes where the file path appears verbatim in the coder's prompt may use direct `Task(subagent_type="paid_coder", ...)` delegation without `declare_scope`. This is a narrow exception; the orchestrator is responsible for verifying the scope is unambiguous.

**Anti-pattern:** do not use `Task` delegation for multi-file feedback fixes just to skip `save_plan` — the loss of scope discipline is not worth the saved ceremony.

## Intake Surfaces

Build a complete feedback ledger before editing. Include every available source:

- validated findings and operational blockers handed off from `swarm-pr-review`,
- pasted user or reviewer feedback,
- GitHub review threads, inline review comments, and review summaries,
- PR issue comments and requested-changes reviews,
- CI/check failures, check annotations, and relevant logs,
- mergeability, conflicts, base drift, and stale PR branch state,
- local validation failures,
- PR body checkboxes, test-plan claims, linked issues, and acceptance criteria,
- commit history and bot/app commits on the PR branch.

If a source is unavailable, retry with alternative access paths. If unavailable after retry, the source is a coverage gap that must be reported to the user — do not silently "record that limitation" and proceed as if the source doesn't matter.

### Async advisory verification lanes

After the complete feedback ledger exists and before editing, use
`dispatch_lanes_async` when available for independent read-only verification lanes:
comment classification, CI/log root-cause inspection, test impact mapping,
release/docs claim checks, and stale-branch/conflict analysis. Partition the
ledger so each `FB-###` item is owned by exactly one verification lane and the
union of lanes covers the entire ledger — no feedback item may be left
unassigned to a lane; state each lane's owned `FB-###` range in its prompt. Scale
the lane count to the ledger size: a 1–3 item round may use a single combined
lane, while a large multi-round intake may warrant one lane per category above.
Cap each `dispatch_lanes_async` batch at 8 lanes (`MAX_LANES`); if the ledger
needs more than 8 verification lanes, dispatch in sequential batches and settle
each batch's COVERAGE GATE before the next — do not over-spawn lanes for a
trivial round. Record each returned `batch_id`, then continue only ledger-safe
architect work: normalize feedback IDs, gather deterministic PR metadata, prepare
reproduction commands, and plan likely fix groups. Do not edit, close items, or
mark feedback resolved from running lanes.

Before the Verification step can mark any item `RESOLVED`, `DISPROVED`,
`PRE_EXISTING`, `NEEDS_MORE_EVIDENCE`, or `NEEDS_USER_DECISION`, every open
verification batch must be fully settled. Poll with `collect_lane_results` (wait
omitted or `false`) to process settled lanes incrementally — clustering confirmed
items and pre-reading files for settled findings while ledger-safe work remains —
then issue a final `collect_lane_results` with `wait: true` per batch once
independent work is exhausted, to confirm every lane is settled.
Missing, stale, cancelled, or failed lanes are coverage gaps that must be closed
before marking any item RESOLVED/DISPROVED/PRE_EXISTING. Apply the COVERAGE GATE:
retry failed lanes (max 2), deploy a verified equivalent alternative (same agent
type, same prompt, same scope, same isolation, with Task-tool dispatch as the
final fallback when lane tools do not work), or stop and surface the lane failure
to the user as BLOCKED.
Do not proceed with "blocking verification and record that async advisory lanes
were unavailable" — record-and-continue is not coverage closure.

### CI matrix cascade check (do this before fixing)

When the PR's `unit` job is a matrix across multiple OSes and downstream jobs
(`integration`, `smoke`) have `needs: unit`, an OS leg failure blocks the
entire pipeline. Before triaging, check:

1. Are `integration` or `smoke` jobs in `skipped` or `cancelled` state rather
   than `failed`? That signals a unit matrix cascade — the unit job failed
   on one OS leg, blocking the downstream jobs from running on the current
   HEAD.
2. If a unit OS leg is the blocker, classify the failure:
   - **Code issue** — the test itself fails. Reproduce locally; if the
     test passes locally, the runner is the problem.
   - **Runner performance** — the test step exceeds the configured timeout.
     Run all files in the step locally with per-file timing; if cumulative
     local runtime is <10 min and the runner can't complete in 60+ min, the
     issue is runner performance. Bump the CI timeout as a stopgap and file
     a follow-up issue for parallelization. Do not loop bumping the timeout
     past 90 min without filing the follow-up.
3. Surface cascade failures to the user explicitly. The downstream jobs'
   results don't exist; the code's coverage of the current HEAD cannot be
   confirmed by CI alone.

### PR body claim verification

PR body text like "PHASE 2 council APPROVED (5/5, round 2)" or "Final council
APPROVED" must be backed by an evidence file in `.swarm/evidence/`
(typically `phase-council.json` or `final-council.json`). Bot-generated PR
bodies commonly auto-fill these claims without real review. Before accepting
such a claim as part of triage:

1. Check whether the corresponding evidence file exists with `verdict:APPROVED`.
2. If the claim is unsupported, mark the closure ledger item as
   `NEEDS_MORE_EVIDENCE` rather than `CONFIRMED`. Do not silently drop the
   claim — it indicates the PR body was generated without a real review.

## Feedback Ledger

Normalize each item before triage:

```text
FB-001 | source | author/tool | status: UNTRIAGED | location | claim | raw link/quote | depends_on
```

Rules:

- Preserve prior `F-###`, `CI-###`, `CONFLICT-###`, `STALE-###`, and similar
  IDs from a review handoff when they already exist. Only mint fresh `FB-###`
  IDs for new feedback discovered after the handoff.
- Preserve reviewer/critic provenance from the handoff artifact so the closure
  ledger can show which items were review-validated before fix work began.
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

### Mandatory: integrate all PR comments with feedback or findings before validation

**Before the Verification step begins, every PR comment that contains feedback
or findings MUST be integrated into the total feedback ledger as a
`FB-###` item.** This is a hard requirement, not a best-effort step.

What counts as "feedback or findings":
- A reviewer request for a code change ("please rename this", "add a test for
  X", "this should call `_internals.foo`")
- A reviewer claim about correctness, security, or style ("this is
  incorrect", "X will leak")
- A bot reviewer's findings table entries
- A CI failure with a specific file:line root cause
- A reviewer question that implies a code change is needed ("why is this
  static?")
- PR review summaries or aggregate comments

What does NOT count (and is therefore not required to be a ledger item):
- Pure acknowledgements ("LGTM", "looks good")
- PR-level metadata changes (title, label, milestone)
- Force-push acknowledgements

Rules:
- **No finding may be addressed outside the ledger.** If you fix something a
  reviewer mentioned, the corresponding `FB-###` item MUST be in the ledger
  before the fix. If you skip the fix, the `FB-###` item MUST be in the
  ledger with a `DISPROVED`, `PRE_EXISTING`, `NEEDS_MORE_EVIDENCE`, or
  `NEEDS_USER_DECISION` status before validation can begin.
- **Status semantics for unaddressed items:**
  - `CONFIRMED` and `PARTIAL` items must be addressed (fixed or
    disproved) before validation can begin. A `CONFIRMED` item that is
    left unaddressed is a regression against the review.
  - `DISPROVED`, `PRE_EXISTING`, `NEEDS_MORE_EVIDENCE`, and
    `NEEDS_USER_DECISION` items may remain open at validation time, but
    each must be explicitly justified in the closure ledger.
- **The closure ledger at the end of the run must account for every `FB-###`
  item** with a final status (fixed / disproved / pre-existing / needs user
  decision / needs more evidence).
- **Comments from the latest bot round take precedence over earlier rounds**
  for the same finding; the earlier-round `FB-###` item is updated with the
  new evidence rather than a new item being created.
- **Multi-round pattern continues to apply** (see "Multi-Round Bot Reviews"
  section). A new bot round adds new `FB-###` items for findings that
  weren't in the prior round; the prior round's items are carried forward
  and updated with the new evidence.

Rationale: silently addressing a review comment without a corresponding
ledger item means the closure summary at the end of the run cannot
demonstrate that every review comment was considered. The closure summary
is the only artifact the user/maintainer reads to confirm the PR is ready
to merge. Missing items in the ledger = missing items in the closure = a
PR that ships with unreviewed feedback.

## Verification

Classify every ledger item before fixing:

| Status | Meaning |
|---|---|
| `CONFIRMED` | The issue is real, reachable or structurally proven, and introduced or exposed by the PR. |
| `PARTIAL` | The comment points at a real concern, but the framing, severity, or requested fix is incomplete. |
| `DISPROVED` | Source, tests, or execution context prove the claim is false, unreachable, or already mitigated. |
| `PRE_EXISTING` | The issue exists on the base branch and is not materially worsened by the PR. |
| `NEEDS_MORE_EVIDENCE` | The claim (e.g., "council APPROVED") is unsupported by stored evidence (e.g., a missing or failed `.swarm/evidence/` artifact); more information is required before triage. |
| `NEEDS_USER_DECISION` | The item requires a product, UX, compatibility, or scope choice that cannot be inferred. |

Verification checklist:

- Read the referenced file and surrounding code.
- Check caller context, reachability, feature flags, schema validation, guards,
  state-machine rules, and permission boundaries.
- Determine whether the issue is PR-introduced, pre-existing, or unresolved.
- Check related tests and whether a failing/proposed test would prove the item.
- Check whether multiple feedback items share one root cause.

### DI seam migration validation

When a test file mutates a DI seam object (e.g., `_internals.foo = mock`),
verify that the production source reads from the seam at call time. A common
anti-pattern: the test mutates the seam object, but the production code
imports the named function (`import { foo } from './module'`) which is bound
at module load. The seam mutation has no effect on the named reference,
so the test fails even though the seam object's `foo === mock`.

Verification: open the source file and grep for call sites. If you see
`import { foo } from '...'` followed by `foo(...)` in the production code,
and the test does `_internals.foo = mock`, the test will fail. The fix is
to change the production code to call `_internals.foo(...)` (or equivalent
active-seam pattern) so the seam mutation is read at call time.

If only a few call sites exist, fix them in the source. If many call sites
exist, consider whether the migration should use `mock.module()` instead,
which replaces the entire module object (including the named export
reference).

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
FB-005 | needs more evidence | .swarm/evidence/phase-council.json missing
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
