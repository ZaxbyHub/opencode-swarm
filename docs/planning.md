# Pre-Swarm Planning

## The Point

The swarm is an execution engine. Good plan in, good code out. Bad plan in, wasted API calls while the Critic tries to salvage it.

Every cycle the Architect spends figuring out *what* to build is a cycle not spent building. Do your planning in free web chat interfaces before you ever open OpenCode.

---

## How It Works

Use multiple AI models (their free web tiers) to debate and poke holes in a single implementation plan. Different models have different blind spots — Claude might approve something Gemini flags as conflicting with a library's actual behavior, or Perplexity might surface a recent CVE the others missed.

A plan that survives scrutiny from 3-6 models is stronger than anything one model produces alone. Once it's solid, drop it in your project and let the Architect run.

---

## Steps

### 1. Snapshot Your Codebase

Use [gitingest](https://gitingest.com) to dump your entire codebase into a single text file. This gives every model the same context.

For new projects, just gather your requirements, architecture notes, and stack decisions.

### 2. Brief Every Model on the Swarm

Paste the [opencode-swarm README](https://github.com/zaxbysauce/opencode-swarm) into each model. The README covers the workflow, task format, and QA gates — that's all they need to structure a plan correctly. You don't need the full plugin codebase unless you're planning changes to the swarm itself.

Each model needs to know:
- The Architect delegates all coding to the Coder — it never writes code itself
- Each task runs through a full 12-step QA gate
- Tasks must be atomic: one file, one concern, one logical change
- Tasks need `FILE`, `TASK`, `CONSTRAINT`, and `ACCEPTANCE CRITERIA` fields
- The Critic reviews the plan before implementation starts

---

## Task Field Reference

Every task in `.swarm/plan.md` must define these four fields:

| Field | Required | Good Example | Bad Example |
|---|---|---|---|
| FILE | Yes | `src/auth/login.ts` | `src/auth/` (directory, not file) |
| TASK | Yes | `Add email format validation to the login handler` | `Update login and add tests` (compound) |
| CONSTRAINT | No | `Do not modify the session logic` | `Be careful` (not actionable) |
| ACCEPTANCE CRITERIA | Yes | `Rejects emails missing @; existing tests pass` | `It works` (not verifiable) |

**Rules:**
- `TASK` must be a single imperative sentence with no "and" connecting two actions.
- `ACCEPTANCE CRITERIA` must be a bullet list specific enough for the test engineer to write a unit test.
- `CONSTRAINT` is optional but recommended when the task touches shared code.

> **`FILE:` has runtime significance beyond documentation.** The swarm extracts all `FILE:` paths from a coder delegation to populate `session.declaredCoderScope`. If the coder modifies files outside of those declared paths, the scope enforcement system flags the violation. Always declare the correct target file — omitting `FILE:` or pointing to a directory disables scope containment for that task.

### Task Sizing

| Size | Definition | Action |
|---|---|---|
| SMALL | 1 file, 1 function or class | Assign directly to plan |
| MEDIUM | 1 file with multiple functions, or up to 2 files | Plan as-is |
| LARGE | More than 2 files, or compound concern | **Must be split before adding to plan** |

If you cannot write `TASK + FILE + CONSTRAINT` in three bullet points, the task is too large.

---

### Task Workflow States

Each task in the swarm follows a per-task state machine. The Architect advances state as gates complete; `update_task_status` enforces the final transition. Understanding these states helps you write acceptance criteria that match what the swarm actually enforces.

| State | Meaning | How It's Entered |
|---|---|---|
| `idle` | Task not yet started | Default state |
| `coder_delegated` | Coder has been given the task | Architect dispatches `Task` to coder |
| `pre_check_passed` | Automated gates passed | `pre_check_batch` returns `gates_passed: true` |
| `reviewer_run` | Human-style review complete | Reviewer delegation returns APPROVED |
| `tests_run` | Verification tests passed | Test engineer delegation returns PASS |
| `complete` | Task fully complete | `update_task_status(status: 'completed')` called |

**Enforcement rule:** `update_task_status` with `status: 'completed'` will be **rejected** unless the task's state is `tests_run` or `complete`. Calling it immediately after the coder returns (skipping reviewer and test gates) returns a structured error naming the missing gate. This means your acceptance criteria should match the gate sequence — not just the code change.

---

### 3. Generate a Draft Plan

Give one model your requirements + codebase snapshot. Ask for a full plan in the swarm's markdown format. This is your starting point, not the final product.

```
Here is my codebase [paste gitingest]. Here is the opencode-swarm README
[paste README]. I need to implement [describe feature/change].

Generate a complete implementation plan in the swarm's markdown format.
Every task must include FILE, TASK, CONSTRAINT, and ACCEPTANCE CRITERIA.
Tasks must be atomic — one file, one concern. No task should touch more
than 2 files. No compound verbs in TASK lines.
```

### 4. Cross-Examine With Other Models

Paste the draft into every other model you have. Ask each to tear it apart:

```
Here is an implementation plan for my project [paste plan]. Here is the
codebase context [paste gitingest]. Here is the swarm plugin that will
execute it [paste swarm README].

Review this plan and tell me:

1. Are any tasks too large or batching multiple concerns?
2. Are there missing dependencies between tasks?
3. Are acceptance criteria testable and specific?
4. Are there architectural risks or edge cases not addressed?
5. Does anything conflict with the existing codebase?
```

### 5. Iterate Until They Agree

Revise based on feedback, then repeat step 4. Keep going until every model signs off — no major objections, no missing pieces, no vague tasks.

This usually takes 2-4 rounds. If you can't converge after 4-5 rounds, your requirements are probably ambiguous. Fix those first.

### 6. Final Validation Checklist

Before handing off to the Architect:

- [ ] Every task has `FILE:`, `TASK:`, `CONSTRAINT:`, `ACCEPTANCE CRITERIA:`
- [ ] No task touches more than 2 files
- [ ] No `TASK:` line contains "and" connecting two separate actions
- [ ] Dependencies are declared explicitly (`depends: X.Y`)
- [ ] Phase structure matches `.swarm/plan.md` format (`## Phase N:`)
- [ ] Acceptance criteria are specific enough for the test engineer to verify
- [ ] Security-sensitive files (auth, crypto, config, env) are flagged so the security reviewer gate triggers

### 7. Hand Off

Save as `.swarm/plan.md` and start the Architect:

```
Implement the plan in .swarm/plan.md. Follow phases sequentially.
Run bun test after each phase. Report progress after each completed task.
```

---

## Model Recommendations

Free tiers are fine for planning. 3-4 models is enough for most work; 5-6 for complex stuff.

| Model | Good At | Free Access |
|---|---|---|
| **Claude** | Reasoning, catching logical gaps | claude.ai |
| **Gemini** | Finding undocumented edge cases | gemini.google.com |
| **ChatGPT** | Broad knowledge, task decomposition | chatgpt.com |
| **Perplexity** | Research-backed, API/library questions | perplexity.ai |
| **Qwen** | Different training data, catches different things | chat.qwen.ai |
| **Deepseek** | Code architecture reasoning | chat.deepseek.com |

---

## How to Tell It's Working

**Converging** — feedback shifts from "this task is missing X" to minor wording nitpicks. All models can trace every requirement to a task. No one finds uncovered files.

**Not converging** — models recommend contradictory approaches, each round surfaces new structural problems, or they disagree on whether the codebase even supports the approach. If tasks keep getting bigger ("this should really be one task covering A, B, and C"), that's a red flag too.

---

## Cost

| Activity | API Cost |
|---|---|
| Multi-model planning in web chat | **$0** |
| Swarm execution of a solid plan | Low — clear tasks, few retries |
| Swarm execution of a vague plan | High — Critic cycles, retries, gate failures |

1-2 hours of free planning routinely saves 3-5x that in execution costs.

---

## Spec Kit

[GitHub Spec Kit](https://github.com/github/spec-kit) automates a similar workflow (spec → plan → tasks) using AI agents in your editor. It's faster. The manual multi-model approach gives you more control and makes cross-model disagreements visible, which matters more for complex or security-sensitive work.

Both produce the same output: a structured `.swarm/plan.md` the Architect can execute.

---

## TL;DR

1. gitingest your codebase + grab the swarm README
2. Generate a draft plan with one model
3. Cross-examine with 3-5 other models
4. Iterate until convergence (2-4 rounds)
5. Run the validation checklist
6. Drop `plan.md` into `.swarm/` and start the Architect

Planning cost: $0 | Planning time: 1-2 hours | Payoff: fewer retries, lower API spend

---

## The Built-In Spec Pipeline

If you prefer to plan inside OpenCode rather than in a separate tool, the swarm has a built-in spec pipeline. It guides you from raw requirements through a validated spec to a complete implementation plan — all without leaving your current session.

### The Three Commands

| Command | When to Use | What It Does |
|---------|-------------|--------------|
| `/swarm specify [description]` | You have a feature idea but no spec yet | Generates `.swarm/spec.md` with FR-### requirements, SC-### success criteria, and user scenarios |
| `/swarm clarify [topic]` | Your spec has `[NEEDS CLARIFICATION]` markers or vague language | Asks targeted questions one at a time, updates spec.md after each accepted answer |
| `/swarm analyze` | You have both a spec and a plan and want a coverage check | Maps FR-### requirements to plan tasks, flags gaps (untasked requirements) and gold-plating (untasked work) |
| `/swarm sdd status|validate|project` | You keep requirements in OpenSpec-compatible files | Inspects `openspec/`, validates the projected effective spec, or materializes `.swarm/spec.md` |

### The Workflow

**Starting from scratch:**
1. `/swarm specify <feature description>` → architect generates spec.md
2. If spec has `[NEEDS CLARIFICATION]` markers → `/swarm clarify` to resolve them
3. Tell the architect to start planning → PLAN mode reads spec.md, optionally offers General Council advisory input when `council.general.enabled` is configured, and cross-references FR-### automatically
4. Optionally `/swarm analyze` after planning to verify coverage

**Importing an existing plan:**
If you already have a plan (e.g. from a prior tool or another session), you can use `/swarm specify` with the plan pasted in — the architect will reverse-engineer a spec from it, validate the plan's format, and surface any gaps.

**Using OpenSpec-compatible artifacts:**
Keep current requirements in `openspec/specs/**/spec.md` and pending deltas in `openspec/changes/*/specs/**/spec.md`. When `.swarm/spec.md` is absent, planning, spec hashing, drift checks, linting, and requirement coverage use an effective Swarm spec projected from those artifacts. Run `/swarm sdd validate` before planning and `/swarm sdd project` when you want to materialize the projection into `.swarm/spec.md`.

**Without a spec:**
Planning works fine without a spec. When you enter PLAN mode without a spec.md, the architect offers to create one first or skip straight to planning. If you skip, planning behavior is identical to prior versions — no behavioral change.

**Using General Council before planning:**
When `council.general.enabled` is true and a Tavily or Brave search API key is configured, MODE: PLAN asks whether to use the three-agent General Council before `save_plan`. If accepted, the architect gathers current external context, records the council consensus/disagreements in `.swarm/context.md`, and uses that input before writing the plan and before critic pre-plan review.

### Spec Format

The spec lives at `.swarm/spec.md`. It contains:
- **Functional requirements** numbered `FR-001`, `FR-002`… — what users need, written with MUST/SHOULD language
- **Success criteria** numbered `SC-001`, `SC-002`… — measurable, technology-agnostic outcomes
- **User scenarios** with Given/When/Then acceptance criteria
- **`[NEEDS CLARIFICATION]` markers** for areas where uncertainty could change scope

The spec deliberately contains NO technology choices, file paths, or implementation details. It captures *what* and *why*, not *how* — leaving HOW to the plan.

### Relationship to the Existing Multi-Model Approach

The built-in spec pipeline is an **alternative path**, not a replacement. The [multi-model planning approach](./planning.md) using external tools (Claude.ai, ChatGPT) remains fully supported and is often the right choice for complex features where you want to iterate on requirements before opening OpenCode.

Use the built-in pipeline when:
- You want a fast spec without switching tools
- Your requirements are clear enough to capture in one session
- You're extending an existing codebase where the spec can be grounded in the current code

---

## Multi-Language Projects

OpenCode Swarm v6.16+ automatically detects project languages by scanning for language-specific marker files (e.g., `package.json`, `Cargo.toml`, `go.mod`, `pubspec.yaml`) and file extensions. No configuration is required for single-language projects.

### Auto-Detection

Language detection runs transparently during tool execution. The `detectProjectLanguages(projectDir)` function returns active profiles sorted by tier. Tier 1 languages (TypeScript/JS, Python, Rust, Go) have the richest tool coverage; Tier 2 and Tier 3 languages have progressively lighter coverage.

### Monorepo Support

For monorepos with multiple language subdirectories, all detected languages are activated. Tool commands run for each detected ecosystem independently — a Go + TypeScript monorepo runs both `go test` and `bun test`, for example.

### Profile-Driven Tool Resolution

Each language profile specifies its own build commands, test frameworks, lint tools, audit command, and SAST rules. The swarm picks the highest-priority tool whose binary is on PATH. If no binary is found, the step is skipped with a soft warning — the pipeline continues.

### Optional External Tools

Some tools require manual installation and are not bundled:

| Tool | Language | Install |
|------|----------|---------|
| `govulncheck` | Go (Tier 1) | `go install golang.org/x/vuln/cmd/govulncheck@latest` |
| `ktlint` | Kotlin | Download from [ktlint releases](https://github.com/pinterest/ktlint/releases) |
| `bundle-audit` | Ruby | `gem install bundler-audit` |
| `cppcheck` | C / C++ | `brew install cppcheck` or `apt install cppcheck` |
| `swiftlint` | Swift | `brew install swiftlint` |

Missing binaries produce a soft warning only — the pipeline never hard-fails on a missing tool.

### Language-Specific Prompt Injection

The coder and reviewer agents automatically receive language-specific constraints and review checklists derived from the task's target file paths. See [Swarm Briefing for LLMs](./swarm-briefing.md) for details.

---

## Curator Integration

The Curator is a background analysis system that provides phase-level intelligence across the project lifecycle. It is **enabled by default**; set `curator.enabled = false` in `.opencode/opencode-swarm.json` to disable it.

### How the Curator Hooks into Execution

The Curator integrates at three points in the swarm execution pipeline:

#### 1. Phase Monitor Init (`src/hooks/phase-monitor.ts`)

On the **first phase** of a project, the phase-monitor hook detects that `lastSeenPhase` is transitioning from `null` and calls `runCuratorInit`. This initializes `.swarm/curator-summary.json` with a baseline entry and persists the init briefing to `.swarm/curator-briefing.md`.

```typescript
// Fires once, on first-phase detection
if (curatorConfig.enabled && curatorConfig.init_enabled) {
  await runCuratorInit(directory, curatorConfig);
  // Briefing is persisted to .swarm/curator-briefing.md
}
```

The init call is wrapped in try/catch — if the Curator fails to initialize, the phase-monitor continues normally.

#### 2. Phase Complete Pipeline (`src/tools/phase-complete.ts`)

After each phase completes (and after the standard `curateAndStoreSwarm()` call), the Curator pipeline runs:

1. **`runCuratorPhase`** — Collects phase events from the event bus, runs compliance checks, and produces a `CuratorPhaseResult`.
2. **`applyCuratorKnowledgeUpdates`** — Merges the phase result's knowledge recommendations into `.swarm/curator-summary.json`, capped at `max_summary_tokens`.
3. **`runCriticDriftCheck`** — Compares planned vs. actual decisions, writes a drift report to `.swarm/drift-report-phase-N.json`.
4. **Compliance surfacing** — If compliance observations exist and `suppress_warnings` is false, they are added to the return value's warnings array (max 5).

The entire pipeline is wrapped in a single try/catch and gated on `curatorConfig.enabled && curatorConfig.phase_enabled`. If any step throws, `phase_complete` is never blocked.

#### 3. Knowledge Injector (`src/hooks/knowledge-injector.ts`)

At the start of each phase, the knowledge-injector hook injects both drift reports and curator briefing:

**Drift injection:**
1. Calls `readPriorDriftReports(directory)` to load all drift reports sorted ascending by phase.
2. Takes the last entry (most recent phase).
3. Calls `buildDriftInjectionText(report, drift_inject_max_chars)` to format it.
4. Prepends the result to `cachedInjectionText`.

**Curator briefing injection:**
1. Reads `.swarm/curator-briefing.md` via `readSwarmFileAsync`.
2. Truncates to 500 characters.
3. Prepends as `<curator_briefing>` tag to `cachedInjectionText`.

**Important:** Both drift reports and curator briefing are injected even when no knowledge entries exist. The injection logic was restructured to run before the `entries.length === 0` check.

### Drift Report Format

Drift reports live at `.swarm/drift-report-phase-N.json` and follow the `DriftReport` interface:

```typescript
interface DriftReport {
  schema_version: 1;
  phase: number;
  timestamp: string;          // ISO 8601
  alignment: 'ALIGNED' | 'MINOR_DRIFT' | 'MAJOR_DRIFT' | 'OFF_SPEC';
  drift_score: number;        // 0.0 (aligned) to 1.0 (completely off-spec)
  first_deviation: {
    phase: number;
    task: string;
    description: string;
  } | null;
  compounding_effects: string[];
  corrections: string[];      // Recommended course corrections
  requirements_checked: number;
  requirements_satisfied: number;
  scope_additions: string[];
  injection_summary: string;  // Truncated summary for architect context injection
}
```

### Configuration Quick Reference

| Field | Default | Effect |
|-------|---------|--------|
| `enabled` | `true` | Master switch; set to `false` to disable Curator activity |
| `init_enabled` | `true` | Run curator init on first phase |
| `phase_enabled` | `true` | Run phase analysis + drift check after each phase |
| `postmortem_enabled` | `true` | Run curator postmortem analysis during closeout |
| `max_summary_tokens` | `2000` | Cap on curator summary size |
| `min_knowledge_confidence` | `0.7` | Minimum confidence for knowledge entry inclusion |
| `drift_inject_max_chars` | `500` | Max chars of drift text injected into architect context |
| `llm_timeout_ms` | `300000` | Timeout for curator init and phase LLM calls |
| `skill_generation_enabled` | `true` | Enable curator-generated skill candidate output |
| `skill_generation_mode` | `draft` | Write generated skill candidates as drafts by default |
| `min_skill_confidence` | `0.7` | Minimum confidence for generated skill candidates |
| `min_skill_confirmations` | `2` | Minimum confirmations before skill promotion |

See the [Curator section in README.md](../README.md#curator) for full configuration details.
