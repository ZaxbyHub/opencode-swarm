# Swarm Briefing for LLMs

This document tells you — an AI model — everything you need to author a valid
`.swarm/plan.md` for the opencode-swarm plugin.

---

## What Is the Swarm

The Architect orchestrates a plan and delegates every coding task to the Coder.
The Coder implements one atomic task at a time. After every task a 14-step QA
gate verifies quality, security, and correctness before progress continues.
The task must also advance through a per-task state machine — `update_task_status`
will reject `status='completed'` unless the state has reached `tests_run`.

---

## Pipeline (14 Steps)

Each step must pass before the next begins:

1. `diff` — detect contract changes in the git diff
2. `syntax_check` — parse changed files; reject syntax errors
3. `placeholder_scan` — flag TODO/FIXME/stub markers left in the diff
4. `imports` — verify all imported symbols resolve; no circular deps
5. `lint fix` — auto-correct style violations with the project linter
6. `build_check` — compile/bundle to confirm the artifact can be produced
7. `pre_check_batch` — parallel: lint check + secrets scan + SAST + quality budget
8. `reviewer` — agent reviews logic, correctness, and alignment with plan
9. `security-reviewer` — triggered when files match auth/crypto/config globs
10. `test_engineer verification` — run test suite; report PASS/FAIL
11. `test_engineer adversarial` — edge-case and attack-vector tests
12. `regression-sweep` — architect runs test_runner with scope:"graph" to find cross-task test regressions
13. `coverage check` — fail if coverage drops below the project threshold
14. `pre-commit checklist` — hard stop before marking task complete

---

## Task Format

Every task in `.swarm/plan.md` must include these fields:

| Field | Required | Description |
|---|---|---|
| FILE | Yes | Relative path to the file the task modifies. **Also used at runtime**: the swarm extracts FILE: values from delegation envelopes and stores them as the declared coder scope — the coder is expected to stay within these files. |
| TASK | Yes | Single imperative sentence — no "and" connecting two actions |
| CONSTRAINT | No | Limiting conditions (e.g., "do not modify other functions") |
| ACCEPTANCE CRITERIA | Yes | Bullet list of verifiable conditions the QA gate can check |

---

## Task Sizing Rules

- **SMALL** — 1 file, 1 function or class. Assign directly to plan.
- **MEDIUM** — 1 file with multiple functions, or up to 2 files. Plan as-is.
- **LARGE** — More than 2 files, or a compound concern. Must be split into
  SMALL/MEDIUM sub-tasks before adding to the plan. A LARGE task in the plan
  is a planning error.

Litmus test: if you cannot write TASK + FILE + CONSTRAINT in three bullet
points, the task is too large. Split it.

---

## Task Deduplication Guidance

**DO NOT create separate "write tests for X" or "add test coverage for X" tasks.** The QA gate (Stage B, step 5l) runs test_engineer-verification on EVERY implementation task. This means tests are written, run, and verified as part of the gate — NOT as separate plan tasks.

Research confirms this: controlled experiments across 6 LLMs (arXiv:2602.07900) found that large shifts in test-writing volume yielded only 0–2.6% resolution change while consuming 20–49% more tokens. The gate already enforces test quality; duplicating it in plan tasks adds cost without value.

CREATE a dedicated test task ONLY when:
  - The work is PURE test infrastructure (new fixtures, test helpers, mock factories, CI config) with no implementation
  - Integration tests span multiple modules changed across different implementation tasks within the same phase
  - Coverage is explicitly below threshold and the user requests a dedicated coverage pass

If in doubt, do NOT create a test task. The gate handles it.

---

## Example Phase Header

```markdown
## Phase 2: Input Validation [IN PROGRESS]
- [x] 2.1: Add email validator to src/auth/login.ts [SMALL]
- [ ] 2.2: Add password policy to src/auth/login.ts [SMALL] (depends: 2.1)
- [ ] 2.3: Add tests/unit/auth/login.test.ts [MEDIUM] (depends: 2.2)
```

---

## Example Fully-Specified Task

```markdown
FILE: src/auth/login.ts
TASK: Add email format validation to the login handler
CONSTRAINT: Do not modify the password validation or session logic
ACCEPTANCE CRITERIA:
- Rejects inputs where email does not match RFC 5322 basic pattern
- Returns HTTP 400 with { error: "invalid_email" } on bad input
- All existing login tests pass unchanged
- New tests cover empty string, missing @, and valid address
```

---

## Key Rules for Plan Authors

- **One task = one file = one concern.** No batching.
- **No compound verbs.** "Add X and update Y" is two tasks.
- **Declare dependencies** with `(depends: N.M)` when ordering matters.
- **Phase headers** use `## Phase N: Title [STATUS]`.
- **Task lines** use `- [ ] N.M: description [SIZE] (depends: N.X)`.
- **Acceptance criteria** must be specific enough for the test engineer to
  verify with a unit test or integration test.

---

## The Spec File: `.swarm/spec.md`

Before writing a plan, you can optionally write a spec. The spec captures *what* users need and *why*, without any implementation details. The architect uses it to validate plans for completeness and catch gold-plating.

### Spec Structure

```markdown
# [Feature Name]

## Feature Description
A 2–4 sentence description of the feature: what users will be able to do and what problem it solves. No technology choices. No implementation details.

## User Scenarios
Given [context], when [action], then [outcome].

## Functional Requirements
- FR-001 [MUST]: [requirement — independently testable, no HOW]
- FR-002 [SHOULD]: [requirement]

## Success Criteria
- SC-001: [measurable outcome — technology-agnostic]
- SC-002: [measurable outcome]

## Key Entities (if data is involved)
- [Entity name]: [brief description — no schema or field definitions]

## Edge Cases and Known Failure Modes
- [edge case or failure mode]

## Open Questions
- [NEEDS CLARIFICATION]: [question — surfaced only after clarification funnel]
  - Category: [scope | security | compatibility | performance | UX | rollout | QA policy]
  - Blocking: [yes | no]
  - Recommended default: [when safe to default]
  - Impact of accepting default: [brief description]
```

### Naming Conventions

- **`FR-###`** — Functional Requirements: what the system MUST or SHOULD do
- **`SC-###`** — Success Criteria: how you know the feature is working
- **`[NEEDS CLARIFICATION]`** — Uncertainty marker placed by the architect only for items that survive the clarification funnel (inventory → classify → consult critic → surface decisions). Use `/swarm clarify` to resolve.

### What the Spec MUST NOT Contain

The spec is technology-agnostic by design. It must not contain:
- Technology stack, framework, or library names
- File paths, API endpoint designs, database schema
- Implementation details ("using React", "via REST API", "stored in PostgreSQL")
- Any "how to build" language

Violating these rules degrades the spec's value as a requirements document and makes it harder for the architect to evaluate plans objectively.

### How It Connects to the Plan

When `.swarm/spec.md` exists and you ask the architect to plan:
1. Each `FR-###` requirement must map to at least one plan task
2. Plan tasks with no corresponding `FR-###` are flagged as potential gold-plating

3. `/swarm analyze` produces a full coverage table: requirements → tasks, gaps, and gold-plating risks

---

## Language-Aware Prompt Injection (v6.16+)

The system enhancer automatically injects language-specific context into agent prompts based on the source files referenced in the current task.

### What Is Injected

**Coder agent** receives a `[LANGUAGE-SPECIFIC CONSTRAINTS — <Language>]` block:
- Up to 10 constraints extracted from the matched language profile's `coderConstraints`
- Injected after existing prompt hardening; does not replace any guardrail blocks
- Example (TypeScript task): *"Use explicit return types on all exported functions"*

**Reviewer agent** receives a `[LANGUAGE-SPECIFIC REVIEW CHECKLIST — <Language>]` block:
- Up to 10 checklist items in `- [ ] item` checkbox format
- Injected additively — does not interfere with adversarial-detection warnings
- Example (Python task): *"- [ ] Verify all functions have type annotations"*

### When Is It Triggered

- Task text contains `src/` file paths with known language extensions (`.ts`, `.py`, `.rs`, `.go`, `.java`, `.kt`, `.cs`, `.cpp`, `.swift`, `.dart`, `.rb`, etc.)
- Language is resolved from the file extension via `getProfileForFile()`
- Multi-language tasks: constraints from all detected languages are merged, capped at 10 total lines

### Agents Affected

| Agent | Injection | Content |
|-------|-----------|---------|
| coder | `coderConstraints` block | Language-specific coding rules |
| reviewer | `reviewerChecklist` block | Language-specific review items |
| architect, test_engineer, others | Not injected | — |

### Interaction with Other Injections

Language injection is **additive**. It does not interfere with:
- Adversarial detection warnings
- Compaction hints
- Guardrail injections
- Budget / scoring blocks

Both Path A (non-scoring) and Path B (scoring/budget) code paths inject language context.

### Customization

Language constraints and checklists live in `src/lang/profiles.ts` per language profile, under `profile.prompts.coderConstraints` and `profile.prompts.reviewerChecklist`. To add or modify rules: edit the relevant profile's arrays. Changes take effect immediately — no rebuild required for the prompt injection path.

---

## Per-Task State Machine (v6.21)

Every task now moves through a tracked workflow state:

| State | Triggered by |
|-------|-------------|
| `idle` | Default for any new task |
| `coder_delegated` | Coder Task delegation detected by `delegation-gate.ts` |
| `pre_check_passed` | `pre_check_batch` returns `gates_passed: true` |
| `reviewer_run` | Reviewer agent returns a verdict |
| `tests_run` | Test engineer completes both verification and adversarial passes |
| `complete` | `update_task_status` accepts `status='completed'` |

Calling `update_task_status` with `status='completed'` will be **rejected** unless the task is in `tests_run` or `complete` state. This is a hard enforcement — not advisory.

Transitions are forward-only: attempting to go from `tests_run` back to `coder_delegated` throws `INVALID_TASK_STATE_TRANSITION`.

---

## Scope Enforcement (v6.21)

The `FILE:` directive in a coder delegation has **runtime significance** beyond documentation: the swarm extracts its value and stores it as `session.declaredCoderScope`. After the coder task completes, if more than 2 files outside the declared scope were written, a scope violation warning fires in the next architect turn.

The architect can also call the `declare_scope` tool explicitly to pre-declare scope before composing the delegation text. Scope entries may be individual file paths or directory paths (all files below a directory are considered in-scope).

---

## Tier-Based Behavioral Prompt Trimming (v6.21)

On smaller/free models (those whose model ID contains `mini`, `nano`, `small`, or `free`), the verbose behavioral guidance blocks in the architect prompt are stripped and replaced with `[Enforcement: programmatic gates active]`. The programmatic mechanisms — state machine, hard blocks, scope containment — provide equivalent safety guarantees without consuming context.
