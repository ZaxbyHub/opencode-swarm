# Plan: Make Worktree Isolation & Parallelization First-Class

Status: IMPLEMENTED & APPROVED (implementation reviewer + critic, see Closeout record)
Date: 2026-06-19
Goal: Worktree isolation shipped but is never used; architects barely ever use
parallel coders. Determine why, ensure it works, and make it first-class.

## Root cause (independently reviewer-validated)

The worktree machinery is **fully implemented, wired, and passing** (162 tests
across `tests/unit/worktree/**`, `tests/unit/turbo/lean/**`, and
`tests/unit/hooks/delegation-gate-worktree-isolation.test.ts`). It is almost
never *triggered* because of front-end and orchestration gaps, not broken
plumbing:

1. **Downstream gating.** Standard worktree provisioning
   (`precreateStandardWorktreeSession`, called from `delegation-gate.ts`
   `toolBefore` ~L1121) only runs when
   `plan.execution_profile.parallelization_enabled === true && max_concurrent_tasks > 1`
   (`delegation-gate.ts:1110-1114`). Worktree isolation is purely a function of
   parallel execution being on.

2. **Parallel execution is opt-in and defaulted off.** `parallelization_enabled`
   defaults `false` (`plan-schema.ts`), `max_concurrent_tasks` defaults `10`. The
   flag is only set when the architect writes `## Pending Parallelization Config`
   (`architect.ts:1382`), which it only does when the **user explicitly answers
   >1** to a passive question: *"How many coders should run in parallel?
   (default: 1)"* (`architect.ts:1375`). The pipeline
   context.md → plan skill (L202) → `save_plan(execution_profile)` → gate works,
   but is rarely entered.

3. **Prompts never teach or recommend it.** `architect.ts` and `coder.ts` contain
   **zero** mentions of "worktree". The architect is never instructed to analyze
   the plan for parallelizable (file-disjoint) work or to recommend a
   concurrency count. Parallelism is buried as an opt-in number with no context.

4. **The EXECUTE rules actively forbid parallel coder dispatch.** Rule 2
   (`architect.ts:163-166`): *"ONE agent per message. Send, STOP, wait for
   response. … This exception NEVER applies to coder delegations."* This
   contradicts the runtime `[PARALLEL EXECUTION PROFILE] … dispatch up to N
   eligible coder task(s) before waiting` advisory. Even a user who enables
   parallelism is told by the static rules to dispatch serially.

5. **(Candidate, verify) Reviewer gate has no parallel exemption.** The reviewer
   gate (`delegation-gate.ts:1054-1099`) throws `REVIEWER_GATE_VIOLATION` when
   **any** task is in `coder_delegated` state at coder dispatch; the **only**
   bypass is `hasActiveTurboMode` (L1086). Standard `parallelization_enabled`
   sessions are not exempted, so a second concurrent coder for a *different*
   dependency-ready task may be blocked. Must be verified at runtime-ordering
   level before/with the fix.

## Design principles

- Lowest-regret first: drive adoption through the architect's deliberation, do
  **not** silently flip global config defaults for a published plugin.
- Safety: only recommend parallel for tasks with **disjoint declared file
  scopes**. The worktree merge-back already aborts + preserves on conflict
  (`merge.ts` mergeLaneBranch → `worktree-isolation.ts` finish → advisory), so
  isolation is the safety net, scope-disjointness is the primary guard.
- Keep the user in control: surface a *recommendation*, not an auto-decision.
- Respect engineering invariants (AGENTS.md): prompts are large strings; edits
  are additive and must not break presence-assertion tests; keep architect.ts
  and `.claude/skills/plan/SKILL.md` dialogue copies in lockstep.

## Changes

### C1 — Architect: proactive parallelization recommendation + worktree concept (keystone)
Files: `src/agents/architect.ts` (`buildQaGateSelectionDialogue`),
`.claude/skills/plan/SKILL.md` (lockstep copy), and the corresponding
`.opencode/skills/.../plan` copy if present.
- Add a concise concept block: parallel coders each run in an **isolated git
  worktree** (own working dir + branch); completed work is auto-merged back.
  Safe and faster for file-disjoint tasks.
- Reframe the parallel-coders question from passive default-1 to **proactive**:
  instruct the architect to inspect the plan's per-task file scopes, group
  dependency-ready tasks with **non-overlapping** file sets, and **recommend** a
  concurrency count = number of such independent groups (clamped 1–4). Present
  the recommendation and rationale to the user, who may still choose 1.
- CRITICAL safety line: never recommend parallel for tasks whose declared file
  scopes overlap or are unknown — recommend serial in that case.
- Preserve the exact strings the presence tests assert (`eleven gates`,
  `phase_council`, `final_council`, `hallucination_guard`,
  `critic_hallucination_verifier`, the commit-frequency block). Note: the
  `how many coders should run in parallel` phrase is currently asserted only in
  `tests/unit/skills/plan-protocol.test.ts` (the skill copy), **not** in the
  architect-dialogue tests — C1 adds that assertion (see Validation).
- Safety semantics (critic axis 3): file-scope disjointness is a **recommendation
  the architect makes**, not a runtime-enforced invariant. A user may still
  override and request parallel for overlapping tasks; the worktree merge-back's
  abort+preserve behavior (`merge.ts` `mergeLaneBranch` → `--abort`;
  `worktree-isolation.ts` `finishStandardWorktreeDispatch` → advisory + preserved
  worktree) is the safety net, not prevention. C1 must state this explicitly so the
  architect prefers serial whenever scopes overlap or are unknown.

### C2 — Architect: permit parallel coder dispatch in EXECUTE mode
File: `src/agents/architect.ts` (Rules 2–3 region, ~L163-166).
- Problem the critic raised: the static prompt has **no plan state at
  render time**, so Rule 2 cannot itself test `parallelization_enabled`. It does
  not need to — the delegation gate already **injects a runtime directive** into
  the architect's context when parallel is active:
  `[PARALLEL EXECUTION PROFILE] parallelization_enabled=true max_concurrent_tasks=N …
  [NEXT] dispatch up to M eligible coder task(s) before waiting`
  (`buildParallelExecutionGuidance`, `delegation-gate.ts` ~L557-676, injected
  ~L2118). The Rule 2 amendment **ties the exception to that runtime signal**, so
  no new context injection is required.
- Exact amendment (append to Rule 2, after the existing coder-exclusion lines):
  > EXCEPTION (parallel mode): when an active `[PARALLEL EXECUTION PROFILE]`
  > directive is present in your context (i.e. `parallelization_enabled=true`),
  > you MAY dispatch multiple coders in a single message — up to the stated
  > `max_concurrent_tasks` — but ONLY for **distinct, dependency-ready tasks
  > whose declared file scopes do not overlap**. Each coder still requires its
  > own `declare_scope` call and carries exactly one TASK. This is the only case
  > in which more than one coder may be dispatched before waiting. If no
  > `[PARALLEL EXECUTION PROFILE]` directive is present, dispatch coders one at a
  > time as usual.
- Rule 3 ("one task per coder call") is **unchanged** — it bans batching multiple
  objectives into a single coder, which still holds in parallel mode.

### C3 — Coder: worktree awareness
File: `src/agents/coder.ts`.
- Add a brief note near IDENTITY/RULES: you may run inside an isolated git
  worktree (a separate working dir on its own branch). Work normally; your
  changes are committed and merged back automatically. Stay strictly within your
  declared file scope so parallel siblings never collide. Do not run
  `git worktree`, branch, or merge commands yourself.

### C4 — Reviewer-gate parallel exemption (verify-then-fix, concrete)
File: `src/hooks/delegation-gate.ts` (reviewer gate ~L1054-1099).
- **Verify first (RED test).** Add a test that, with `parallelization_enabled` and
  `max_concurrent_tasks: 2`, places task A in `coder_delegated` and dispatches a
  coder for **task B** through `toolBefore`. Assert current behavior. If it throws
  `REVIEWER_GATE_VIOLATION`, the block is real and C4's code change lands; if it
  does not throw, C4's code change is unnecessary and we keep only the test as a
  regression guard.
- **Concrete fix (if blocked).** The gate already runs after the plan is loaded
  for worktree precreate; resolve the incoming coder's task id the same way the
  worktree path does — `resolveDelegatedPlanTaskId(args, planTaskIds)` (used at
  L1120). Then, *before* the existing per-task throw loop, branch on parallel mode:
  - Load `profile.parallelization_enabled` and
    `effectiveMaxConcurrent = session.maxConcurrencyOverride ?? max_concurrent_tasks`.
  - Let `incomingTaskId` = resolved incoming task id (may be null if unresolved).
  - Let `coderDelegatedCount` = number of tasks in `coder_delegated` state.
  - If `parallelEnabled && effectiveMaxConcurrent > 1 && incomingTaskId != null`:
    - If `incomingTaskId` is itself in `coder_delegated` → **still throw** (this is
      a true re-delegation of an unreviewed task; review must run first).
    - Else if `coderDelegatedCount >= effectiveMaxConcurrent` → **throw a
      slots-exhausted error** (`PARALLEL_SLOTS_EXHAUSTED`: wait for an in-flight
      coder to be reviewed before dispatching another).
    - Else → **allow** (skip the per-task `coder_delegated` throw loop for this
      different, dependency-ready task).
  - Non-parallel sessions keep the exact existing behavior (unchanged code path).
- **"slots-available"** is defined precisely as
  `effectiveMaxConcurrent - coderDelegatedCount`.
- Add a comment at the gate documenting the exemption. Add a concurrency test that
  is RED before the fix and GREEN after (second different-task coder allowed;
  same-task re-delegation still blocked; slot exhaustion still blocked).

### C5 — Roadmap / design doc
File: `docs/` (this plan, plus a durable design note).
- Document what worktree isolation is, how it is wired, why it was unused, the
  changes made, and the remaining roadmap to fully first-class: surfacing
  degradation advisories to the user, a recovery playbook for preserved
  worktrees on merge conflict, and an *optional* future config to default
  parallel-on for disjoint plans.

### C6 — Release note fragment
File: `docs/releases/pending/` per repo convention (front-matter `type`/`issue`).

## New tests required (critic-mandated)
- **T1 — architect parallel-question presence.** In
  `src/__tests__/qa-gate-hardening.test.ts`, assert
  `buildQaGateSelectionDialogue('SPECIFY'|'BRAINSTORM'|'PLAN')` contains
  `how many coders should run in parallel` and the new worktree concept phrase.
- **T2 — lockstep sync.** A test asserting the architect dialogue and
  `.claude/skills/plan/SKILL.md` (and `.opencode/skills/plan/SKILL.md`) share the
  key parallel/worktree substrings, so the copies cannot silently drift.
- **T3 — reviewer-gate parallel exemption (C4).** RED-before/GREEN-after:
  second different-task coder allowed under parallel mode; same-task re-delegation
  still throws; slot exhaustion (`coderDelegatedCount >= max`) still throws.

## Lockstep copies that MUST change together (critic axis 4)
- `src/agents/architect.ts` `buildQaGateSelectionDialogue`
- `.claude/skills/plan/SKILL.md` AND `.opencode/skills/plan/SKILL.md` (byte-identical;
  both carry the dialogue ~L202+). The `specify` and `brainstorm` skills also embed
  the parallel-coders line — update them only if their copy diverges from the new text.

## Validation plan
- `bun test` on: `tests/unit/worktree/**`, `tests/unit/turbo/lean/**`,
  `tests/unit/hooks/delegation-gate*`, `tests/unit/config/parallelization-config.test.ts`,
  `src/__tests__/qa-gate-hardening.test.ts`,
  `tests/unit/agents/architect-hallucination-gate.test.ts`,
  `tests/unit/skills/plan-protocol.test.ts`,
  `src/commands/registration-parity.test.ts`, the concurrency test, and the new
  T1–T3 tests.
- Full lint/typecheck per repo gate (`bun run lint:check` / biome + `tsc`).
- Swarm closeout: independent implementation reviewer + separate critic on the
  final diff and evidence; fix-and-re-review any NEEDS_REVISION/REJECTED.

## Explicitly out of scope (roadmapped, not done now)
- Flipping global config defaults to parallel-on (risky for published plugin).
- A dedicated automated file-conflict-detection tool (architect uses declared
  scopes + worktree conflict-abort safety net; tool is future work).
- Changing the worktree `policy` default away from `auto`.

## Closeout record (swarm contract)

- Plan critic (pre-implementation): NEEDS_REVISION → all 5 required changes folded
  into this plan (concrete C2/C4 specs, T1/T2/T3 tests, scope-conflict semantics).
- Implementation reviewer (gate 1): NEEDS_REVISION — Rule 2 edit broke the exact
  substring asserted by `tests/unit/agents/architect-workflow-security.test.ts`
  ("Exception: Stage B reviewer/test_engineer gate agents…" / "This exception
  NEVER applies to coder delegations"). FIXED by restoring the original Stage-B
  wording verbatim and adding a separate parallel-mode exception clause.
- Implementation reviewer (gate 1, second pass): APPROVED.
- Critic (final challenge on post-fix diff): APPROVED — parallel exception is
  narrowly gated, slot cap is not evadable, task-id resolution is fail-closed on
  ambiguity, worktree isolation is genuinely first-class, no invariant violations.
- Objective validation: tsc --noEmit clean; biome clean; new tests
  (qa-gate-hardening, plan-protocol lockstep, C4 reviewer-gate exemption) green;
  security test 51/51; agent suite shows 35 pre-existing failures WITH and WITHOUT
  the change (0 net new failures).
