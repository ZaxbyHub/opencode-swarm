# v8: parallel-first execution by default for provably disjoint work

## What

opencode-swarm v8 flips the product's published core execution contract from
serial-by-default to **safe-concurrent-by-default for provably disjoint work**,
with serial execution as the **automatic, gate-enforced** fallback whenever
scopes overlap or are unknown.

This is the v8 flagship (issue #1674). It ships two prerequisite engine pieces
in the same release so the new default is bounded by real plan-time conflict
detection (#1656) and real merge-back recovery UX (#1657).

## Before

- The Coder/pipeline executed one task at a time. `docs/architecture.md` and
  `README.md` both stated this contract.
- Parallel execution was opt-in: the architect had to write
  `## Pending Parallelization Config` with `parallelization_enabled: true`, and
  it only fired for plans the user explicitly configured.
- There was no plan-time conflict-detection tool — the only enforcement was a
  merge-time abort that preserved the worktree.
- Merge-back conflict recovery info was not durable and could be deleted by
  routine orphan-branch cleanup before a human ever saw it.

## After

- **New plans default to `parallelization_enabled: true`** at `save_plan` time.
  A plan with two provably file-disjoint task groups executes them concurrently
  in isolated git worktrees by default — no config flag required.
- **The execution gate enforces serial automatically** when the active phase's
  pending tasks have overlapping or unknown declared scopes. This is not
  advisory: the gate computes the disjointness verdict inline on every coder
  dispatch (via the same pure helper the new `plan_conflict_check` tool uses).
- **`plan_conflict_check` tool (#1656)** — read-only advisory check that returns
  a pairwise file-conflict matrix, a verdict (`all_disjoint` /
  `conflicts_present` / `unknown_scopes`), and a suggested serialization order.
  Gated to the `architect`. Writes nothing.
- **Durable merge-back recovery (#1657)** — recovery records under
  `.swarm/recovery/`; `/swarm status` shows a "Preserved recovery worktrees"
  section; `cleanupOrphanedBranches` exempts recovery branches (fail-safe on
  read error); `lean_turbo_run_phase` now includes per-task degradation reasons
  in its result, not just task IDs.
- Orphaned modules deleted: `src/parallel/dependency-graph.ts` and
  `src/parallel/meta-indexer.ts` (zero production importers; #1656 part 2).

## Migration

- **Existing plans are unchanged.** The v8 `parallelization_enabled: true`
  default applies ONLY at new-plan creation (in `save_plan`'s Step 3.1). The
  zod schema default stays `false`, so a v7 plan loaded via `PlanSchema.parse`
  keeps its behavior (serial unless it already had `parallelization_enabled:
  true`).
- **A revision of an existing profile-less plan also gets the v8 default**
  (effectively-new). To keep an existing plan serial when revising it, pass
  `execution_profile: { parallelization_enabled: false }` explicitly to
  `save_plan`.
- No action required for users who already set `parallelization_enabled`
  explicitly — their value is preserved.

## Opt-out

- **Per-plan:** `execution_profile.parallelization_enabled: false` at
  `save_plan` time.
- **Globally (disable worktree isolation entirely):** `worktree.policy:
  'disabled'` in plugin config.

## Breaking changes

- **New-plan execution model change** (semver-major). New plans may now execute
  tasks concurrently where they previously executed serially. The gate's
  disjointness enforcement bounds this to provably-safe cases, but the
  observable behavior of a fresh plan differs from v7.
- **Architect prompt change:** the architect now notes the v8 default and
  points to `plan_conflict_check`.
- **`lean_turbo_run_phase` tool result:** adds an additive `degradedDetails`
  field (full degraded-task objects alongside the existing `degradedTasks`
  string array). Existing consumers of `degradedTasks` are unaffected.

## Known caveats

- **Orphan-cleanup fails safe.** If `.swarm/recovery/` exists but is unreadable
  (e.g. a corrupt record file), `cleanupOrphanedBranches` skips ALL lane-branch
  deletions for that pass. Recovery safety trumps orphan cleanliness. To restore
  normal cleanup, resolve or clear the corrupt recovery record (run
  `clearRecoveryRecord`, or delete the offending file under `.swarm/recovery/`).
- **`plan_conflict_check` must be re-run if the plan changes.** The gate
  recomputes the verdict on every dispatch (always fresh), but the architect's
  advisory view is a point-in-time snapshot. If pending tasks change, re-run the
  tool for an up-to-date matrix.
- **Co-change signal is opt-in.** `plan_conflict_check` defaults to path-only
  disjointness (fast, git-free). Pass `use_cochange: true` to fold in `git log`
  co-change signal for richer coupling detection on tightly-coupled codebases.
- **Parallelism applies to tasks dispatched together while pending.** The gate
  computes the disjointness verdict over the active phase's currently-`pending`
  tasks on each coder dispatch. Concurrency is achieved by dispatching multiple
  coders in a single architect turn (the `[PARALLEL EXECUTION PROFILE]`
  directive instructs this). Adding a coder to an already-in-flight set via a
  later turn fails *safe* (serial) — disjointness is only provable over the
  pending set, not against tasks already `coder_delegated`/`in_progress`.
- **Composition constraint.** This v8 flip and the background-subagent GA
  (#1676) must NOT both flip defaults in the same release. A pre-merge test
  guards this (#1676 stays opt-in).

## Related

- Closes #1674 (v8 flagship: parallel-first execution)
- Closes #1656 (`plan_conflict_check` tool + orphaned-module deletion)
- Closes #1657 (worktree merge-conflict recovery durability + orphan safety)
- Prior art: `docs/dev/worktree-parallelization-first-class-plan.md` (C1–C4
  shipped under v7; this release lifts the explicitly-deferred default flip,
  conflict tool, and recovery UX).
