# Mechanical gates for PR review and feedback

## What changed

- Activating `/swarm pr-review` or `/swarm pr-feedback` now creates a durable,
  session-scoped workflow gate under `.swarm/pr-workflow-gates/`.
- PR review base dispatch is rejected unless the initial async wave contains
  all six repository-agnostic review dimensions with the required structured
  labels. The controller rechecks an exact clean checkout at the bound PR head;
  every review dispatch must also supply a live base ref and exact merge base,
  from which the controller derives the complete authoritative PR diff scope;
  failed obligations can be repaired only by head-bound structured
  retry batches with exact durable provenance.
- Micro-lane review now uses 11 portable risk families, requires exact-set
  accounting, rejects every `NO-MATCH` applicability waiver, and verifies that
  every row points to a completed, non-degraded micro-lane artifact before
  head-bound reviewer or critic
  dispatch. Critic batches mechanically join declared reviewer obligations.
- PR feedback verification now requires a complete immutable item inventory and
  exact, non-overlapping lane ownership. Direct writes and coder delegation are
  blocked until every verification lane settles with a usable artifact at the
  immutable PR head. The gate also covers detected shell writes, git/GitHub
  mutation commands, and remote mutation tools.
- `run_pr_feedback_stage_a` executes repository-supplied array-form targeted
  reproduction/regression and exact `git diff --check` commands plus every
  concrete workspace/category/source build, typecheck, and lint obligation
  mechanically discovered from repository manifests, configs, scripts, or a
  bounded `.pr-validation.json` validator contract that is byte-identical to
  the immutable `base_ref`/`base_sha` merge-base copy, then binds the
  receipts to a content digest and an exact per-item reproduction-target and
  expected-behavior map for the immutable feedback inventory.
  Receipts must be obligation-distinct, category-compatible,
  non-publishing, and non-noop; reproduction requires an explicit selected
  target and non-empty runner output. Contained standard Gradle/Maven wrappers
  and exact repository-contract validators are supported only from that trusted
  base copy. Contract-authorized
  package scripts preserve their exact contract path/id on the obligation and
  receipt, require non-empty output, and may run only through an exact inspected
  npm, pnpm, yarn, or Bun script selection. Unsupported workspace-glob semantics
  fail closed instead of silently omitting workspaces; unverified opaque wrappers
  and package-script names remain rejected.
  HEAD, index, refs, upstream, Git config, and content are rechecked
  around every command. Package-manager commands must use a category-matching
  script or recognized executable form; configuration queries, missing-script
  waivers, help/list/dry-run modes, and non-building build-tool modes are
  rejected. Repositories without a mechanical signal for an optional category
  are not forced to invent no-op proof. The controller subsequently requires one fresh
  Stage B reviewer, one test engineer, a separate closeout reviewer, and a final
  critic in strict order with one exact positive row per feedback ID. Any edit
  invalidates the sequence; commit, push, and remote publication stay blocked
  until the full current-revision chain passes. The controller then permits one
  standalone commit, requires a clean index/worktree and a non-merge direct
  child whose sole parent is the intake head, binds that exact post-commit HEAD,
  and only then arms one non-force, single-ref push of the literal bound commit
  to the bound upstream branch. Aliases, wrappers, force/mirror operations,
  extra refspecs, and unrelated remote writes fail closed.
- Settled artifacts must exist in the integrity-checked lane-output store and contain the
  phase-specific parseable marker contract; non-empty planning prose does not
  count as coverage. Workflow lane, agent, role, child-session, parent-session,
  mode, source, PR head, checkout head, content revision, and output integrity
  must all match the durable delegation record; incompatible output-ref
  collisions fail closed. Reviewer and critic retries also require one coherent
  fully successful exact batch rather than complementary partial successes.
  Structured PR-workflow lane prompts also receive a controller-appended,
  caller-non-overridable block binding lane ID, exact head, revision, scope, and
  assigned items. Unresolved or cross-field-incoherent critic rows do not settle.
- `complete_pr_workflow` validates terminal coverage and open batches, arms
  publication without clearing the gate, and clears only on a second call after
  the exact approved commit is observed at both the exact upstream
  remote-tracking ref and a bounded query of the actual remote branch bound
  during arming. Local fetch/ref forgery is not publication proof. Active modes cannot overwrite each other,
  PR review requires independent reviewer evidence, and PR feedback requires
  its Stage B/closeout test-engineer, reviewer, and critic evidence.
- PR workflow authority follows OpenCode session ancestry, so coder and nested
  child tool calls inherit the parent feedback gate. A child cannot commit,
  push, mutate remote state, or rewrite protected evidence before the parent
  reaches the matching mechanical transition.
- An active PR workflow also gates architect response completion: final text is
  replaced with a blocked notice, and an idle parent session is automatically
  resumed until `complete_pr_workflow` clears the durable obligations. A newer
  reviewer batch invalidates every older critic batch.
- The package smoke budget is raised from 4.9 MiB to 5.4 MiB to accommodate the
  controller and its integrity checks while retaining roughly 350 KB of headroom;
  another 10% increase still fails the guard.
- Conflicting speed-first guidance was removed. Time, token, repository-size,
  and predicted simplicity are not valid reasons to waive a required gate.

## Why

Prompt-only requirements allowed architects to silently reduce required lane
fan-out or skip risk-specific verification. The new controller-backed contract
turns those requirements into machine-checked obligations and keeps the skills
portable across repositories.

## Migration and compatibility

Custom callers of `dispatch_lanes_async` in PR workflows must provide the new
structured `mode`, `workflow_lane`, `pr_head_sha`, `base_sha`, `base_ref`, `trigger_evaluation`,
`feedback_inventory`, and `feedback_item_ids` fields described by the skills.
PR-feedback fix workflows must also call `run_pr_feedback_stage_a` and use the
four ordered `swarm-pr-feedback:*` validation modes before publication.
Dispatch outside PR review and PR feedback is unchanged.

No versioned data migration is required. Existing gate files are isolated by
session and schema version.
