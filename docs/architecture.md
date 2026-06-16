# OpenCode Swarm Architecture

## Design Philosophy

OpenCode Swarm is built on a simple premise: **multi-agent systems fail when they're unstructured**.

Most frameworks throw agents at a problem and hope coherence emerges. It doesn't. You get race conditions, conflicting changes, lost context, and code that doesn't work.

Swarm enforces discipline:
- One Architect owns all decisions
- One task executes at a time
- Every task gets QA'd before the next starts
- Project state persists in files, not memory

---

## Control Model

```
                    ┌─────────────┐
                    │  ARCHITECT  │
                    │  (control)  │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│   EXPLORER    │  │     SMEs      │  │   PIPELINE    │
│  (discovery)  │  │  (advisory)   │  │ (execution)   │
└───────────────┘  └───────────────┘  └───────────────┘
                                              │
                                   ┌──────────┴──────────┐
                                   │                     │
                                   ▼                     ▼
                           ┌─────────────┐       ┌─────────────┐
                           │    CODER    │       │     QA      │
                           │ (implement) │       │  (verify)   │
                           └─────────────┘       └─────────────┘
```

### Architect: The Brain
- Owns the plan
- Makes all delegation decisions
- Synthesizes inputs from other agents
- Handles failures and escalations
- Maintains project memory

### DEEP_DIVE Protocol (On-Demand Skill)
When the architect receives a `[MODE: DEEP_DIVE ...]` signal, it triggers a high-rigor, read-only codebase audit. This protocol is now implemented as a specialized **Skill**, loaded on-demand to keep the core architect prompt lean and focused.

The protocol executes in the following stages:

1. **Parse Header**: Extracts `scope`, `profile`, `max_explorers`, and other configuration from the signal.
2. **Repo Readiness**: Checks git status and ensures the environment is ready for a deep audit.
3. **Scope Resolution**: Uses `repo_map` and `symbols` to build a detailed SCOPE MAP of the audit boundary.
4. **Explorer Missions (Parallel Waves)**: Dispatches parallel explorer waves to discover patterns, dataflow, and vulnerabilities based on the selected profile.
5. **Normalize Candidates**: Deduplicates and ranks findings by severity (CRITICAL → INFO).
6. **Parallel Reviewers**: Two independent reviewers verify or reject each candidate finding.
7. **Critic Challenge**: For HIGH/CRITICAL findings, sequential critic passes challenge the verdict to eliminate false positives.
8. **Final Report**: Assembles the Wiring Map, Functionality Assessment, and a Verified Findings Table.

This mode is strictly **read-only**: it does NOT mutate source code, delegate to the coder, or call `declare_scope`.

### Repo Graph Ontology

`repo_map` is the shared structural-awareness surface for planning and review.
It persists `.swarm/repo-graph.json` using the same bounded async graph builder
that runs after plugin registration, so on-demand `repo_map action="build"` and
startup graph injection now read/write the same graph schema.
The published package exposes only the root plugin entry and `./package.json`
through `package.json#exports`; the Bun-targeted CLI remains available via
`bin` and is intentionally not exported as a package subpath.

The graph stores imports, exports, inferred file roles, route facts, data
operations, security-related facts, conventions, and ontology findings. Query
actions include:

- `importers`, `dependencies`, `blast_radius`, `localization`, and `key_files`
  for dependency and impact analysis.
- `ontology` for one file's roles, routes, data/security facts, conventions,
  and findings.
- `package_boundaries` for inferred package/layer summaries across the graph.
- `preflight_packet` for a bounded agent packet covering target files,
  ontology facts, findings, and a target-local package-boundary summary.

The ontology extractor is intentionally conservative. It records detected facts
and "detected missing guard" findings; it does not claim formal security proofs.
Tree-sitter remains the syntax and AST-diff engine, while repo graph startup
continues to use bounded source scanning to preserve plugin-init invariants.

### Signal-Triggered Modes (On-Demand Skills)

`DEEP_DIVE` is one of several **signal-triggered modes**. A `/swarm <command>` handler emits a `[MODE: X ...]` activation signal; the architect recognizes it and loads the matching `### MODE: X` section + skill on demand. This keeps the core prompt lean while supporting deep specialized workflows.

Discovery is deliberate and robust:
- The command-delivery layer detects a `[MODE: ...]` signal and instructs the architect to **enter that mode and load its skill** — it does not present the signal as output to echo.
- A top-priority **SIGNAL-TRIGGERED MODE** rule sits at the head of the architect's MODE-detection ladder: if a `[MODE: X ...]` header is present and a matching `### MODE: X` section exists, the architect enters it immediately, overriding any other routing. Free text after the closing bracket is treated as additional instructions for that mode.

Current signal-triggered modes: `DEEP_DIVE`, `PR_REVIEW`, `PR_FEEDBACK`, `DESIGN_DOCS`, `COUNCIL`, `ISSUE_INGEST` (and the spec-workflow modes `SPECIFY`, `BRAINSTORM`, `CLARIFY-SPEC`).

#### PR_REVIEW Protocol
Triggered by `/swarm pr-review`. A read-only, structured review: intent reconstruction → 6 parallel explorer lanes via the `dispatch_lanes` join barrier → independent reviewer confirmation → critic challenge on HIGH/CRITICAL → synthesis. The architect checks out the PR branch locally before exploring (explorers read the working tree, not git history) and launches the skill's triggered micro-lanes for risk categories present in the diff. Does NOT mutate source or delegate to the coder.

#### PR_FEEDBACK Protocol
Triggered by `/swarm pr-feedback`. Ingests and closes **known** feedback (review threads, requested changes, CI failures, conflicts, pasted notes) rather than discovering new findings. The architect checks out the PR branch, builds a complete feedback ledger, verifies every item against source (CONFIRMED / DISPROVED / PRE_EXISTING / NEEDS_USER_DECISION), fixes confirmed items plus their tests/docs, and reports a closure ledger for every item. GitHub review threads are resolved only on explicit user instruction.

### Explorer: The Eyes

Fast codebase scanner and factual mapping agent. Explorer is **strictly observational** — it reports what is observed without judgment, verdict, or directive.

#### Identity Rules
- Explorer **analyzes directly** — does NOT delegate to sub-agents
- Output is under 2000 characters
- Read-only: cannot write, edit, or patch code

#### Analysis Protocol (Phase 2 Hardening)

Explorer systematically reports across four dimensions:

| Dimension | Content |
|-----------|---------|
| **STRUCTURE** | Entry points and call chains (≤3 levels), public API surface (exports with signatures), internal/external dependencies |
| **PATTERNS** | Design patterns (factory, observer, strategy), error handling approach (throw/Result/error callback), state management (global/module/passed), configuration pattern (env/config/hardcoded) |
| **COMPLEXITY INDICATORS** | Structural complexity — cyclomatic complexity, deep nesting, complex control flow, large files (>500 lines), deep inheritance/type hierarchies |
| **RUNTIME/BEHAVIORAL CONCERNS** | Missing error handling paths, platform-specific assumptions (path separators, line endings, OS APIs) |

#### Output Sections (Phase 2)

| Section | When Populated | Example |
|---------|----------------|---------|
| `OBSERVED CHANGES` | INPUT referenced specific files | What changed in those targets |
| `CONSUMERS_AFFECTED` | Integration impact mode | Files importing changed symbols |
| `RELEVANT CONSTRAINTS` | Always | Architectural patterns, error handling coverage, platform assumptions, established conventions |
| `FOLLOW-UP CANDIDATE AREAS` | Always | Observable conditions warranting later review (e.g., "function has 12 parameters — consider splitting") |
| `DOMAINS` | Always | Relevant SME domains (typescript, nodejs, powershell, etc.) |

#### Judgmental Language Removed (Phase 2)

Explorer output uses **observational language only**. The following were removed:
- `VERDICT` → replaced with `COMPATIBILITY SIGNALS` (COMPATIBLE / INCOMPATIBLE / UNCERTAIN)
- `MIGRATION_NEEDED` → replaced with `MIGRATION_SURFACE` (observable call signatures affected)
- `REVIEW NEEDED`, `dead`, `missing` labels → removed
- All directive language → recast as observable conditions

#### Integration Impact Analysis Mode

Activates when delegated with "Integration impact analysis" or INPUT lists contract changes. Uses `diff` + `imports` tools to classify each change as BREAKING or COMPATIBLE and list all affected consumer files.

#### Documentation Discovery Mode

Automatically activates during codebase reality check at plan ingestion. Uses `doc_scan` to build a manifest index of project docs, then `doc_extract` to surface relevant constraints per task using Jaccard bigram similarity scoring.

#### Curator Modes

Explorer also operates in two curator modes for phase boundary consolidation:

| Mode | Trigger | Purpose |
|------|---------|---------|
| `CURATOR_INIT` | Session start | Consolidates prior session knowledge into architect briefing; flags contradictions |
| `CURATOR_PHASE` | Phase complete | Extends running digest with phase outcomes; observes workflow deviations and knowledge update candidates |

Both curator modes are dispatched via the standard `MODE: EXPLORER` with the appropriate curator mode trigger (`CURATOR_INIT` or `CURATOR_PHASE`). Explorer uses `OBSERVATIONS` (not `KNOWLEDGE_UPDATES`) and reports with observational language — no directives.

#### Role Boundary Hardening (Phase 3–5)

Explorer's behavioral boundaries were tightened across Phases 3–5 to eliminate residual routing authority and preserve its discovery function.

**Explorer's scope is strictly factual.** Explorer reports what is observed without judgment, verdict, or directive. Explorer does not route tasks, prioritize findings, or declare areas out-of-scope.

**Architect owns all routing decisions.** `DOMAINS` and `FOLLOW-UP CANDIDATE AREAS` are Explorer output fields — they are informational hints for the architect to consider. Explorer does not delegate, dispatch, or determine next steps. Only the architect decides what to act on.

**Reviewer must validate Explorer findings.** Explorer observations are not authoritative. Reviewer and other consumers of Explorer output must independently verify factual claims before using them in decisions or implementations.

**Critic remains a pure challenge layer.** Critic does not map code, scan files, or make routing decisions. Its role is to challenge the architect's plan — not to replace the explorer.

**Speed preservation is a design goal.** Explorer's efficiency is intentional. Lightweight, fast scans serve the architect better than exhaustive analysis that delays routing decisions.

**Explorer output is for architect consumption, not autonomous action.** No agent other than the architect should treat Explorer output as a directive or verdict.

**Test coverage.** Role boundary hardening is validated by `explorer-role-boundary.test.ts` (25 tests) and `explorer-consumer-contract.test.ts` (58 tests). All 182 explorer tests pass. The test suite enforces that Explorer output contains only observational language, that `VERDICT` and `MIGRATION_NEEDED` never appear, and that routing authority is never asserted by Explorer.

**Before and after examples:**

The following judgmental language was systematically removed from Explorer output and replaced with observational language only:

| Removed (judgmental) | Added (observational) |
|-----------------------|------------------------|
| `VERDICT: INCOMPATIBLE — needs rewrite` | `COMPATIBILITY SIGNALS: INCOMPATIBLE — observable call signatures affected: 3` |
| `VERDICT: COMPATIBLE — safe to use` | `COMPATIBILITY SIGNALS: COMPATIBLE — no observable call signature conflicts detected` |
| `REVIEW NEEDED — dead code` | `FOLLOW-UP CANDIDATE AREAS: function has 12 parameters, 8 of which are unused in current call sites` |
| `MIGRATION_NEEDED: X must be rewritten` | `MIGRATION_SURFACE: 5 call sites reference the affected function signature` |
| `REVIEW NEEDED — missing labels` | `FOLLOW-UP CANDIDATE AREAS: 3 exported functions lack doc comments` |

All directive language (must, should, needs, verdict, review needed, dead) was recast as observable conditions. Explorer reports facts; the architect decides what to do with them.

### Designer: The Blueprint
- UI/UX specification agent
- Generates component scaffolds and design tokens before coding begins on UI-heavy tasks
- Runs in MODE: EXECUTE before Coder (Rule 9)

### SME: The Advisor
- Single open-domain expert (any domain: security, ios, rust, kubernetes, etc.)
- Consulted serially, one call per domain
- Guidance cached in context.md
- Read-only (cannot write code)

### Pipeline Agents: The Hands
- Coder: Implements one task at a time
- Reviewer: Dual-pass review — general correctness first, then automatic security-only pass for security-sensitive files (OWASP Top 10 categories)
- Test Engineer: Generates verification tests + adversarial tests (attack vectors, boundary violations, injection attempts)
- Gates: Automated `diff`, `imports`, `lint`, and `secretscan` tools verify contracts, dependencies, style, and security before/during review.

### Critic: The Gate
- Reviews architect's plan BEFORE implementation begins
- Returns APPROVED / NEEDS_REVISION / REJECTED
- Read-only (cannot write code)

### Docs: The Scribe
- Documentation synthesizer
- Automatically updates READMEs, API docs, and guides based on implementation changes
- Runs in Phase 6 as part of project wrap-up
- **`docs_design` role variant** (opt-in via `design_docs.enabled`, issue #1080): the same agent in a design-doc-author role. Generates/syncs language-agnostic design docs (`domain.md`, `technical-spec.md`, `behavior-spec.md`, `reference/*`) for the project under build via `/swarm design-docs` (`MODE: DESIGN_DOCS`). A deterministic, fail-open per-phase drift check (`src/hooks/design-doc-drift.ts`) writes `.swarm/doc-drift-phase-N.json` and advises a sync when docs fall behind code/spec.

---

## Execution Flow

### Phase 0: Initialize or Resume

```
Is .swarm/plan.md present?
├── YES → Read plan.md and context.md
│         Find current phase and task
│         Resume execution
│
└── NO  → New project
          Proceed to Phase 1
```

### Phase 1: Clarify

```
Is the user request clear?
├── YES → Proceed to Phase 2
│
└── NO  → Run clarification funnel:
          1. Inventory all uncertainties (no cap)
          2. Classify each (self_resolved / critic_resolved /
             research_needed / user_decision / deferred_nonblocking)
          3. Consult critic_sounding_board
          4. Surface only surviving decisions as packet
          Then proceed
```

### Phase 2: Discover

```
@explorer analyzes codebase
    │
    ├── Project structure
    ├── Languages and frameworks
    ├── Key files
    ├── Patterns observed
    └── Relevant SME domains
```

### Phase 3: Consult SMEs

```
For each relevant domain:
    │
    ├── Check context.md for cached guidance
    │   └── If cached → Skip this SME
    │
    └── If not cached:
        ├── Delegate to @sme with DOMAIN: [domain]
        ├── Wait for response
        └── Cache guidance in context.md
```

### Phase 4: Plan

```
Create/Update .swarm/plan.md:
    │
    ├── Project overview
    ├── Phases (logical groupings)
    │   └── Tasks (atomic units of work)
    │       ├── Dependencies
    │       ├── Acceptance criteria
    │       └── Complexity estimate
    │
    └── Status tracking
```

### Phase 4.5: Critic Gate

```
MODE: CRITIC-GATE

@critic reviews plan
    │
    ├── APPROVED → Proceed to MODE: EXECUTE
    ├── NEEDS_REVISION → Revise plan, resubmit (max 2 cycles)
    └── REJECTED → Escalate to user
```

### MODE: EXECUTE

```
For each task in current phase:
    │
    ├── Check dependencies complete
    │   └── If blocked → Skip, mark [BLOCKED]
    │
    ├── 5a. @coder implements (ONE task only)
    │       └── → REQUIRED: Print task start confirmation
    │
    ├── 5b. diff + imports tools analyze changes + semantic diff injection
    │       ├── Detect contract changes (exports, interfaces, types)
    │       ├── Track import dependencies across files
    │       ├── system-enhancer injects AST-based semantic diff summary into reviewer context
    │       │   - Computes AST diffs for changed files (up to 10, from `declaredCoderScope`)
    │       │   - Enriches with blast radius (consumers count from repo graph)
    │       │   - Generates risk-ranked markdown for reviewer prioritization
    │       │   - Fully error-resilient: never throws, returns null on failure
    │       └── → REQUIRED: Print change summary
    │
    ├── 5c. syntax_check validates code syntax (v6.9.0)
    │       ├── Tree-sitter parse validation for 20 languages
    │       ├── Catches syntax errors before review
    │       └── → REQUIRED: Print syntax status
    │
    ├── 5d. placeholder_scan detects incomplete code (v6.9.0)
    │       ├── Scans for TODO/FIXME comments
    │       ├── Detects placeholder text and stub implementations
    │       └── → REQUIRED: Print placeholder scan results
    │
    ├── 5e. lint fix → lint:check (auto-fix then verify)
    │       ├── Run `lint` tool with fix mode, then check mode
    │       └── → REQUIRED: Print lint status
    │
    ├── 5f. imports audit analyzes dependencies (AST-based)
    │       ├── Track import dependencies across files
    │       └── → REQUIRED: Print import analysis
    │
    ├── 5g. build_check verifies compilation (v6.9.0)
    │       ├── Runs repo-native build/typecheck commands
    │       ├── Validates code compiles correctly
    │       └── → REQUIRED: Print build status
    │
    ├── 5h. pre_check_batch runs parallel verification (v6.10.0)
    │       ├── Runs 4 tools in parallel with p-limit (max 4 concurrent):
    │       │   ├── lint:check (code quality verification - hard gate)
    │       │   ├── secretscan (secret detection - hard gate)
    │       │   ├── sast_scan (security analysis - hard gate)
    │       │   └── quality_budget (maintainability metrics)
    │       ├── Returns unified result with gates_passed boolean
    │       ├── If gates_passed === false → Return to coder with specific failures
    │       └── → REQUIRED: Print gates_passed status

    ├── 5i. @reviewer reviews (correctness, edge-cases, performance)
    │       ├── APPROVED → Continue
    │       └── REJECTED → Retry from 5a (max 5)
    │       └── → REQUIRED: Print approval decision
    │
    ├── 5j. @reviewer security-only pass (if file matches security globs
    │       or coder output contains security keywords)
    │       ├── Security globs: auth, crypto, session, token, middleware, api, security
    │       ├── Uses OWASP Top 10 2021 categories
    │       └── → REQUIRED: Print security approval
    │
    ├── 5k. @test_engineer generates AND runs verification tests
    │       ├── PASS → Continue
    │       └── FAIL → Send failures to @coder, retry from 5a with RETRY protocol
    │       └── → REQUIRED: Print test results
    │
├── 5l. @test_engineer adversarial testing pass
│ ├── Attack vectors, boundary violations, injection attempts
│ ├── PASS → Continue
│ └── FAIL → Send failures to @coder, retry from 5a with RETRY protocol
│ └── → REQUIRED: Print adversarial test results
│
├── 5m. architect regression sweep (scope:"graph")
│ ├── Runs test_runner with scope:"graph" to find cross-task test regressions
│ ├── If no related tests beyond task scope → SKIP. Print "regression-sweep: SKIPPED — no related tests beyond task scope"
│ ├── If additional tests pass → PASS. Print "regression-sweep: PASS [N additional tests, M files]"
│ ├── If additional tests FAIL → return to coder: "REGRESSION DETECTED: Your changes broke [N] tests in [test files]"
│ └── → REQUIRED: Print regression-sweep result
│
├── 5n. ⛔ HARD STOP: Pre-commit checklist (v6.11.0)
    │       ├── [ ] All QA gates passed (lint:check, secretscan, sast_scan)
    │       ├── [ ] Reviewer approval documented
    │       ├── [ ] Tests pass with evidence
    │       └── [ ] No security findings
    │       └── → REQUIRED: Print checklist completion
    │       **No override. A commit without completed QA gate is a workflow violation.**
    │
    └── 5o. TASK COMPLETION CHECKLIST (v6.11.0)
            ├── Evidence written to .swarm/evidence/{taskId}/
            ├── update_task_status called with status='completed' (advances state machine to 'complete')
            └── → REQUIRED: Print completion confirmation
```

### MODE: PHASE-WRAP

```
All tasks in phase done
│
├── 1. @explorer - Rescan codebase after changes
├── 2. @docs - Update documentation for all changes in this phase
├── 3. Update context.md with learnings and decisions
├── 4. Write retrospective evidence via write_retro tool
├── 4.5. Run evidence_check to verify all completed tasks have required evidence
├── 5. Run sbom_generate with scope='changed' for dependency snapshot
├── 5.5. Defense-in-depth drift check: Delegate to @critic_drift_verifier BEFORE phase_complete
│ - Returns early feedback on plan drift
│ - Architect calls `write_drift_evidence(phase, verdict, summary)` tool after critic_drift_verifier returns
│ - Writes drift verification evidence to .swarm/evidence/{phase}/drift-verifier.json
│ - Verdict automatically normalized: APPROVED → approved, NEEDS_REVISION → rejected
│ - Skip this step if spec.md does not exist
├── 5.6. Verify mandatory gate evidence exists:
│         - .swarm/evidence/{phase}/completion-verify.json (auto-written by completion-verify gate)
│         - .swarm/evidence/{phase}/drift-verifier.json (written by @critic_drift_verifier)
│         - .swarm/evidence/{phase}/hallucination-guard.json (if hallucination_guard enabled; written by write_hallucination_evidence)
│         - .swarm/evidence/{phase}/mutation-gate.json (if mutation_test enabled; written by write_mutation_evidence after generate_mutants + mutation_test)
│         - .swarm/evidence/{phase}/phase-council.json (if phase_council enabled; written by submit_phase_council_verdicts)
│         - .swarm/evidence/{phase}/architecture-supervisor.json (if architectural_supervision enabled; written by write_architecture_supervisor_evidence)
│         - .swarm/evidence/final-council.json (if final_council enabled; written by write_final_council_evidence, last phase only)
│         If either missing: run the missing gate first
│         Note: Gates 1–5 bypassed in turbo mode; architecture-supervisor and final-council are never bypassed
├── 6. Call phase_complete (enforces up to seven gates automatically)
│         - Gate 1: completion-verify — deterministic identifier check in source files
│         - Gate 2: drift verifier evidence — reads drift-verifier.json for approved verdict
│         - Gate 3: hallucination guard — reads hallucination-guard.json for approved verdict (if enabled)
│         - Gate 4: mutation gate — reads mutation-gate.json for pass/warn/fail verdict (if enabled)
│         - Gate 5: phase council — reads phase-council.json for approved verdict (if phase_council enabled)
│         - Gate 5b: architecture supervisor — reads architecture-supervisor.json (if enabled, never turbo-bypassed)
│         - Gate 6: final council — reads final-council.json for approved verdict (if final_council enabled, last phase only, never turbo-bypassed)
│         - Gates 1–5 bypassed when turbo mode is active; Gates 5b and 6 are never bypassed
└── 7. Ask user: "Ready for Phase [N+1]?"
```

### Phase Completion Gates

The `phase_complete` tool enforces up to seven gates before marking a phase complete. Gates 1–5 and phase council are turbo-bypassed; architecture supervisor and final council are never turbo-bypassed.

| Gate | Purpose | Blocking Reason | Turbo Bypass |
|------|---------|-----------------|--------------|
| `completion-verify` | Deterministic check that plan task identifiers exist in source files | `COMPLETION_INCOMPLETE` — zero identifiers found in target files | Yes |
| `drift-verifier` | Evidence-based check that `critic_drift_verifier` approved the implementation | `DRIFT_VERIFICATION_MISSING` or `DRIFT_VERIFICATION_REJECTED` | Yes |
| `hallucination-guard` | Evidence-based check that `critic_hallucination_verifier` approved plan/implementation claims | `HALLUCINATION_VERIFICATION_MISSING` or `HALLUCINATION_VERIFICATION_REJECTED` | Yes |
| `mutation-test` | Evidence-based check that mutation tests achieved a passing kill rate | `MUTATION_GATE_MISSING` or `MUTATION_GATE_FAIL` | Yes |
| `phase-council` | Evidence-based check that `submit_phase_council_verdicts` ran and approved (if `phase_council` enabled) | `PHASE_COUNCIL_REQUIRED` — no approved phase-council evidence | Yes |
| `architecture-supervisor` (5b) | Evidence-based check that `critic_architecture_supervisor` approved cross-task coherence | `ARCHITECTURE_SUPERVISION_BLOCKED` | **No** |
| `final-council` (Gate 6) | Evidence-based check that `write_final_council_evidence` approved project completion | `FINAL_COUNCIL_REQUIRED` — no approved final-council evidence | **No** |

**Gate 1: Completion Verify**
- Parses plan task descriptions for identifiers (backtick, camelCase, PascalCase, config keys)
- Scans target source files for matches
- Blocks if zero identifiers found in any task's target files
- Non-blocking on errors — treats as warning and continues

**Gate 2: Drift Verifier Evidence**
- Reads `.swarm/evidence/{phase}/drift-verifier.json`
- Checks for entry with `type` containing 'drift' and `verdict` of 'approved'
- Blocks if evidence missing or verdict is 'rejected'
- Defense-in-depth: architect should delegate to `@critic_drift_verifier` BEFORE calling `phase_complete` for early feedback
- Uses `write_drift_evidence` tool to persist verification results (verdict is normalized automatically)

**Gate 3: Hallucination Guard (optional)**
- Only enforced when `hallucination_guard: true` in the QA gate profile
- Reads `.swarm/evidence/{phase}/hallucination-guard.json`
- Checks for entry with `type` containing 'hallucination' and `verdict` of 'approved'
- Blocks if evidence missing or verdict is 'rejected'
- Architect should delegate to `@critic_hallucination_verifier` and call `write_hallucination_evidence` before `phase_complete`
- Enabled via `set_qa_gates` tool with `hallucination_guard: true`

**Gate 4: Mutation Gate (optional)**
- Only enforced when `mutation_test: true` in the QA gate profile (default: OFF)
- Reads `.swarm/evidence/{phase}/mutation-gate.json`
- Checks for entry with `type` of 'mutation-gate' and verdict of 'pass', 'warn', or 'skip'
- **Blocks** if verdict is 'fail' — resolve surviving mutants or lower threshold before continuing
- **Warns** (proceeds) if verdict is 'warn'
- **Allows** if verdict is 'pass' or 'skip'
- Architect workflow: call `generate_mutants` to create patches, pipe patches to `mutation_test` tool, then call `write_mutation_evidence` with verdict and kill rate metrics before `phase_complete`
- Enabled via `set_qa_gates` tool with `mutation_test: true`
- **Expensive**: requires one LLM call per mutation phase due to LLM-based patch generation; OFF by default to avoid cost on all projects

**Turbo Mode Behavior:**
When `hasActiveTurboMode()` returns true, Gates 1–5 (completion-verify, drift-verifier, hallucination-guard, mutation-test, phase-council) are automatically bypassed. The `phase_complete` tool logs a warning and proceeds without enforcement. Gate 5b (architecture supervisor) and Gate 6 (final council) are **never** turbo-bypassed — enabling `architectural_supervision.mode === 'gate'` or `final_council` is an explicit opt-in to a hard quality check.

---

## MODE Labels (v6.11)

### Plan Cursor (v6.13)

The `plan_cursor` config enables a compact representation of the project plan that is injected into the LLM context, keeping the total token count under a configurable limit.

```json
{
  "plan_cursor": {
    "enabled": true,
    "max_tokens": 1500,
    "lookahead_tasks": 2
  }
}
```

- **enabled** – When `true` (default) Swarm injects a plan cursor instead of the full `plan.md`.
- **max_tokens** – Upper bound on tokens emitted for the cursor (default 1500). The cursor includes the current phase summary, the full current task, and up to `lookahead_tasks` upcoming tasks. Earlier phases are reduced to one‑line summaries.
- **lookahead_tasks** – Number of future tasks to include in full detail (default 2). Set to `0` to show only the current task.

Disabling (`"enabled": false`) falls back to the pre‑v6.13 behavior of injecting the entire plan text.

### Tool Output Truncation (v6.13)

Controls the size of tool outputs sent back to the LLM.

```json
{
  "tool_output": {
    "truncation_enabled": true,
    "max_lines": 150,
    "per_tool": {
      "diff": 200,
      "symbols": 100,
      "search": 200,
      "batch_symbols": 150,
      "suggest_patch": 50
    }
  }
}
```

- **truncation_enabled** – Global switch (default true).
- **max_lines** – Default line limit for any tool output.
- **per_tool** – Overrides `max_lines` for specific tools. `diff`, `symbols`, `search`, and `batch_symbols` are truncated by default because their outputs can be very large. `suggest_patch` uses a conservative limit since patch output is typically compact.

When truncation is active, a footer is appended to the output:

```
---
[output truncated to {maxLines} lines – use `tool_output.per_tool.<tool>` to adjust]
```

### Structured Search Tool — `search` (v6.45.0)

Added as the default structured search path for workspace pattern lookup. Replaces shell `grep` workarounds with a machine-readable JSON output.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `pattern` | `string` | required | Search pattern (literal or regex) |
| `workspace` | `string` | required | Root directory to search |
| `mode` | `"literal" \| "regex"` | `"literal"` | Match mode |
| `glob` | `string[]` | `[]` | Include globs (e.g. `["**/*.ts"]`) |
| `exclude` | `string[]` | `[]` | Exclude globs |
| `maxResults` | `number` | `100` | Hard cap on returned matches |
| `maxLines` | `number` | `10` | Max lines per match snippet |
| `context` | `number` | `0` | Surrounding lines per match (only when > 0) |

Returns structured JSON with `file`, `line`, `text`, and `truncated` fields per hit. Falls back to a graceful error when ripgrep is unavailable. **Not a structural AST search** — combine with `symbols` and `imports` for full module analysis.

**Registered for**: architect, coder, reviewer, explorer, test_engineer.

### Reviewer-Safe Patch Suggestion Tool — `suggest_patch` (v6.45.0)

Generates structured diff hunks for a target file without modifying it. Used by the reviewer agent to deliver actionable remediation artifacts in read-only review passes.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `file` | `string` | required | Target file path |
| `patch` | `string` | required | Unified diff body |
| `context` | `number` | `3` | Context lines per hunk |

Returns structured patch output with hunk anchors. Detects and reports stale context when the file content has changed since the patch was authored. **Not a write tool** — no file is modified. Not registered for coder agents.

**Registered for**: reviewer, architect.

### Batched Symbol Extraction — `batch_symbols` (v6.45.0)

Extracts exported symbols from multiple files in a single call. Each file is processed independently with per-file error isolation — a parse failure in one file does not affect others.

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `files` | `string[]` | required | List of file paths to analyse |
| `includeTopLevel` | `boolean` | `false` | Include non-exported top-level definitions |

Returns a per-file symbol summary with `exports`, `topLevel` (optional), `parseError`, and `empty` fields. Benchmarks show 75–98% call reduction versus sequential single-file calls. Reuses `symbols.ts` parsing logic.

**Registered for**: architect, explorer, reviewer.

### Tool-Name Normalization — `normalizeToolName` (v6.45.0)

Canonical helper for stripping namespace prefixes from tool names (e.g. `mega:search` → `search`, `mega.search` → `search`). Exposed via `src/hooks/normalize-tool-name.ts`.

| Function | Description |
|----------|-------------|
| `normalizeToolName(name)` | Returns the bare tool name string |
| `normalizeToolNameLowerCase(name)` | Returns the bare tool name in lowercase |

Replaces 13 inline `replace(/^[^:]+[:.]/, '')` regex patterns that were duplicated across `guardrails/index.ts`, `guardrails/tool-before.ts`, scope-guard.ts, index.ts, delegation-gate.ts, self-review.ts, and delegation-ledger.ts. Test-file sites are excluded — they validate the raw pattern behavior directly.

### Mode Detection (v6.13)

Swarm now explicitly distinguishes five architect modes, which affect what injection blocks are added to the LLM prompt.

| Mode | When Injected |
|------|----------------|
| `DISCOVER` | After the explorer finishes scanning the codebase. |
| `PLAN` | When the architect writes or updates the plan. |
| `EXECUTE` | During task implementation (the normal pipeline). |
| `PHASE-WRAP` | After all tasks in a phase are completed, before docs are updated. |
| `UNKNOWN` | Fallback when the current state does not match any known mode. |


The Architect workflow uses explicit **MODE** labels internally to distinguish architect execution phases from project plan phases:

| MODE | Description |
|------|-------------|
| `MODE: RESUME` | Detect and restore previous session state |
| `MODE: CLARIFY` | Ask clarifying questions for ambiguous requirements |
| `MODE: DISCOVER` | Explore codebase structure and patterns |
| `MODE: CONSULT` | Consult SMEs for domain guidance |
| `MODE: PLAN` | Create or update project plan (includes CODEBASE REALITY CHECK on brownfield) |
| `MODE: CRITIC-GATE` | Plan review checkpoint before execution |
| `MODE: EXECUTE` | Task implementation with QA gates |
| `MODE: PHASE-WRAP` | Phase completion and retrospective |

> **CODEBASE REALITY CHECK (v6.29.2):** Before any planning (MODE: PLAN), spec generation (MODE: SPECIFY), or plan import, the Architect dispatches Explorer in targeted scoped chunks to verify the current state of every referenced item. Produces a CODEBASE REALITY REPORT with statuses: NOT STARTED, PARTIALLY DONE, ALREADY COMPLETE, or ASSUMPTION INCORRECT. This prevents planning against stale assumptions (e.g., assuming a function exists when it was already fixed). Skipped for purely greenfield projects with no existing codebase references.

**NAMESPACE RULE**: MODE labels refer to the architect's internal workflow phases. Project plan phases (in `.swarm/plan.md`) remain as "Phase N" to avoid confusion.

### Observable Output (v6.11)

All blocking steps require explicit printed output for visibility:

```
→ REQUIRED: Print {description}
```

This ensures:
- Clear progress tracking through gates
- Determinable failure points
- Evidence of execution for debugging

### Retry Protocol (v6.11)

On gate failure, emit structured rejection:

```
RETRY #{count}/5
FAILED GATE: {gate_name}
REASON: {specific failure}
REQUIRED FIX: {actionable instruction}
RESUME AT: {step_5x}
```

**Failure Counting**: Track retry count, escalate to user after 5 failures.

### Anti-Exemption Rules (v6.11)

The following rationalization patterns are explicitly blocked:

1. "It's a simple change"
2. "Just updating docs"
3. "Only a config tweak"
4. "Hotfix, no time for QA"
5. "The tests pass locally"
6. "I'll clean it up later"
7. "No logic changes"
8. "Already reviewed the pattern"

**Rule**: There are NO simple changes. There are NO exceptions to the QA gate sequence.

### Pre-Commit Rule (v6.11)

⛔ **HARD STOP** before marking any task complete:

- [ ] All QA gates passed (no overrides)
- [ ] Reviewer approval documented
- [ ] Tests pass with evidence
- [ ] No security findings

There is no override. A commit without a completed QA gate is a workflow violation.

### Task Granularity Rules (v6.11)

Tasks classified by size with strict decomposition rules:

| Size | Criteria | Decomposition Required |
|------|----------|----------------------|
| **SMALL** | 1 file, single verb, <2 hours | No |
| **MEDIUM** | 1-2 files, compound action, <4 hours | No |
| **LARGE** | >2 files OR compound verbs | **Yes** |

**Task Atomicity Checks** (Critic validates):
- Max 2 files per task (otherwise decompose)
- No compound verbs ("and", "plus", "with") in task descriptions
- Clear acceptance criteria required

---

## File Structure

```
project/
├── .swarm/
│   ├── plan.md            # Legacy phased roadmap (migrated to plan.json)
│   ├── plan.json          # Machine-readable plan with Zod-validated schema
│   ├── context.md         # Project knowledge, SME cache
│   ├── evidence/          # Per-task execution evidence
│   │   ├── 1.1/           # Evidence for task 1.1
│   │   └── 2.3/           # Evidence for task 2.3
│   └── history/
│       ├── phase-1.md     # Archived phase summaries
│       └── phase-2.md
│
├── src/
│   ├── index.ts           # Plugin entry — registers 8 hook types
│   ├── state.ts           # Shared swarm state singleton (zero imports)
│   ├── agents/            # Agent definitions and factory
│   ├── config/            # Schema, constants, loader
│   ├── commands/          # Slash command handlers (12 commands)
│   │   ├── index.ts       # Factory + dispatcher (createSwarmCommandHandler)
│   │   ├── status.ts      # /swarm status
│   │   ├── plan.ts        # /swarm plan [N]
│   │   ├── agents.ts      # /swarm agents
│   │   ├── evidence.ts    # /swarm evidence [task]
│   │   ├── archive.ts     # /swarm archive [--dry-run]
│   │   └── reset.ts       # /swarm reset --confirm
│   ├── hooks/             # Hook handlers
│   │   ├── index.ts       # Barrel exports
│   │   ├── utils.ts       # safeHook, composeHandlers, readSwarmFileAsync, estimateTokens
│   │   ├── extractors.ts  # Plan/context file parsers
│   │   ├── pipeline-tracker.ts      # Message transform (pipeline logging)
│   │   ├── context-budget.ts        # Message transform (token budget warnings)
│   │   ├── system-enhancer.ts       # System prompt transform + cross-agent context
│   │   ├── compaction-customizer.ts # Session compaction enrichment
│   │   ├── agent-activity.ts        # Tool hooks (activity tracking + flush)
│   │   ├── delegation-tracker.ts    # Chat message hook (active agent tracking)
│   │   └── cc-command-intercept.ts  # CC command interception (hard-block /reset, soft-correct /plan)
│   ├── lang/             # Language profiles, framework detector (PHP, Laravel, etc.)
│   ├── tools/             # Domain detector, file extractor, gitingest, diff, retrieve-summary
│   ├── plan/              # Plan management
│   │   └── manager.ts     # load/save/migrate/derive plan operations
│   └── evidence/          # Evidence bundle management
│       ├── index.ts       # Barrel exports
│       └── manager.ts     # CRUD: save/load/list/delete/archive evidence
│
├── tests/unit/            # 1214 tests across 54+ files (bun test)
│   ├── agents/            # creation (64), factory (20), architect-v6-prompt (15),
│   │                      # security-categories (12)
│   ├── config/            # constants (14), schema (35), loader (17), plan-schema (40),
│   │                      # evidence-schema (23), evidence-config (8),
│   │                      # review-integration-schemas (20)
│   ├── hooks/             # pipeline-tracker (16), utils (25), system-enhancer (58),
│   │                      # compaction-customizer (26), context-budget (23),
│   │                      # extractors (32), agent-activity (14), delegation-tracker (16),
│   │                      # guardrails (39), system-enhancer-v6 (18), cc-command-intercept (23 unit + 22 adversarial)
│   ├── commands/          # status (6), plan (9), agents (28), index (11),
│   │                      # archive (8), benchmark (5)
│   ├── evidence/          # manager (25)
│   ├── plan/              # manager (40)
│   ├── tools/             # domain-detector (30), file-extractor (16), gitingest (5),
│   │                      # diff (22), retrieve-summary (28)
│   ├── smoke/             # packaging (8)
│   └── state.test.ts      # Shared state (31)
│
├── tests/adversarial/     # 22 adversarial tests for cc-command-intercept (bun test)
└── dist/                  # Build output (ESM)
```

### plan.md Schema

```markdown
# Project: [Name]
Created: [ISO date]
Last Updated: [ISO date]
Current Phase: [N]

## Overview
[1-2 paragraph project summary]

## Phase 1: [Name] [STATUS]
Estimated: [SMALL/MEDIUM/LARGE]

- [x] Task 1.1: [Description] [SIZE]
  - Acceptance: [Criteria]
- [ ] Task 1.2: [Description] [SIZE] (depends: 1.1)
  - Acceptance: [Criteria]
  - Attempt 1: REJECTED - [Reason]
  - Attempt 2: REJECTED - [Reason]
- [BLOCKED] Task 1.3: [Description]
  - Reason: [Why blocked]

## Phase 2: [Name] [PENDING]
...
```

### context.md Schema

```markdown
# Project Context: [Name]

## Summary
[What the project does, who it's for]

## Technical Decisions
- [Decision]: [Rationale]

## Architecture
[Key patterns, file organization]

## SME Guidance Cache
### [Domain] (Phase [N])
- [Guidance point]

## Patterns Established
- [Pattern]: [Where/how used]

## Known Issues / Tech Debt
- [ ] [Issue to address later]

## File Map
- [path]: [Purpose]
```

---

## Agent Permissions

| Agent | Read | Write | Execute | Delegate |
|-------|:----:|:-----:|:-------:|:--------:|
| architect | ✅ | ✅ | ✅ | ✅ |
| explorer | ✅ | ❌ | ❌ | ❌ |
| sme | ✅ | ❌ | ❌ | ❌ |
| coder | ✅ | ✅ | ✅ | ❌ |
| reviewer | ✅ | ❌ | ❌ | ❌ |
| critic | ✅ | ❌ | ❌ | ❌ |
| test_engineer | ✅ | ✅ | ✅ | ❌ |

### Architect-Only Tools

Some tools are restricted to the architect and cannot be called by other agents:

| Tool | Purpose |
|------|---------|
| `update_task_status` | Mark plan tasks as `pending \| in_progress \| completed \| blocked` |
| `write_retro` | Write retrospective evidence bundles before `phase_complete` |
| `declare_scope` | Pre-declare which files the coder may modify for a given task |

---

## File Locking for Concurrent Write Safety

Swarm uses file locking to prevent concurrent writes from corrupting shared state files. Even though tasks execute serially, agents may still race on `plan.json` and `events.jsonl` during phase transitions or when multiple sessions interact with the same project.

### Implementation

- **Library**: `proper-lockfile` with `retries: 0` (fail-fast — no polling)
- **Lock acquisition**: `tryAcquireLock(directory, filename, agentName, taskId)` before every write to a shared state file
- **Lock release**: `_release()` called in a `finally` block to ensure cleanup even on error
- **Tagging**: Each lock records the agent name and task context for diagnostics

### Protected Files

| File | Tool | Lock Behavior |
|------|------|---------------|
| `.swarm/plan.json` | `update_task_status` | Exclusive lock acquired before calling `updateTaskStatus()`. Lock losers return `success: false` with `recovery_guidance: "retry"`. |
| `.swarm/events.jsonl` | `phase_complete` | Lock acquired before `appendFileSync`. If lock is unavailable, logs a warning and proceeds without lock protection (non-blocking). |

### `update_task_status` Lock Semantics

```
Caller A: tryAcquireLock(plan.json) → acquired=true → write → _release()
Caller B: tryAcquireLock(plan.json) → acquired=false → returns { success: false, recovery_guidance: "retry" }
```

Only one call wins. The loser receives:
```json
{
  "success": false,
  "message": "Task status write blocked: plan.json is locked by architect (task: update-task-status-1.1-1234567890)",
  "errors": ["Concurrent plan write detected — retry after the current write completes"],
  "recovery_guidance": "Wait a moment and retry update_task_status. The lock will expire automatically if the holding agent fails."
}
```

The architect should retry after a short delay. Sequential calls (no contention) always succeed.

### Why Not Just Serial Execution?

Tasks execute serially, but the architect may dispatch multiple concurrent agent sessions or tool calls that race on plan/event file writes. Locking provides a second layer of protection against corruption from:

1. Concurrent `update_task_status` calls from different sessions
2. `phase_complete` concurrent appends to `events.jsonl`
3. Race conditions during session rehydration or recovery

### Lock Recovery

If the lock holder crashes, the OS or lock library will eventually clean up the stale lock file. On retry, the next call will acquire the lock and proceed. Swarm does not auto-retry on lock contention — the architect receives the error and decides when to retry.

---

## Failure Handling

### Task Rejection

```
Attempt 1: @coder implements
           @reviewer rejects with feedback
           
Attempt 2: @coder fixes based on feedback
           @reviewer rejects again
           
Attempt 3: @coder fixes again
           @reviewer rejects
           
Escalation: Architect handles directly
            OR re-scopes task
            Document in plan.md
```

### Blocked Tasks

```
Task cannot proceed (external dependency):
├── Mark [BLOCKED] in plan.md
├── Record reason
├── Skip to next unblocked task
└── Inform user
```

### Agent Failure

```
Agent times out or errors:
├── Retry once
├── If still failing:
│   └── Architect handles directly
└── Document in context.md
```

### Model Fallback (v6.33)

When an agent encounters a transient model error (rate limit, 429, 503, timeout, overloaded, model not found), the guardrails hook detects the failure and triggers fallback behavior:

**Detection:** The `toolAfter` hook in `guardrails/index.ts` checks for null/undefined tool output combined with error messages matching `TRANSIENT_MODEL_ERROR_PATTERN`:

```typescript
const TRANSIENT_MODEL_ERROR_PATTERN =
  /rate.?limit|429|503|timeout|overloaded|model.?not.?found|temporarily unavailable|server error/i;
```

**Behavior on transient error:**
1. Increment `session.model_fallback_index` (position in fallback_models array)
2. Set `session.modelFallbackExhausted = true` (prevents advisory spam)
3. Inject `MODEL FALLBACK` advisory into `session.pendingAdvisoryMessages`

**Behavior on success:**
- Reset `session.model_fallback_index = 0`
- Reset `session.modelFallbackExhausted = false`

**Configuration:** Per-agent `fallback_models` array (max 3) in `AgentOverrideConfigSchema`:

```typescript
export const AgentOverrideConfigSchema = z.object({
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  disabled: z.boolean().optional(),
  fallback_models: z.array(z.string()).max(3).optional(),
});
```

### Bounded Coder Revisions (v6.33)

When a task requires multiple coder attempts (e.g., reviewer rejections), the guardrails hook tracks revision counts and warns when limits are approached.

**State fields:**
- `session.coderRevisions` — Number of times the coder has been re-delegated for the current task
- `session.revisionLimitHit` — Boolean flag set when `coderRevisions >= max_coder_revisions`

**Detection:** The `toolAfter` hook in `guardrails/index.ts` increments `session.coderRevisions` when a coder delegation completes:

```typescript
// In guardrails/index.ts toolAfter handler
if (delegation.isDelegation && delegation.targetAgent === 'coder') {
  if (!session.revisionLimitHit) {
    session.coderRevisions++;
    const maxRevisions = cfg.max_coder_revisions ?? 5;
    if (session.coderRevisions >= maxRevisions) {
      session.revisionLimitHit = true;
      session.pendingAdvisoryMessages.push(
        `CODER REVISION LIMIT: Agent has been revised ${session.coderRevisions} times ` +
          `(max: ${maxRevisions}) for task ${session.currentTaskId ?? 'unknown'}. ` +
          `Escalate to user or consider a fundamentally different approach.`
      );
    }
  }
}
```

**Reset:** `coderRevisions` resets to 0 when a new coder delegation is dispatched (unless `revisionLimitHit` is already true).

**Configuration:** `guardrails.max_coder_revisions` in `GuardrailsConfigSchema` (default: 5, range: 1–20).

**Snapshot persistence:** Both `coderRevisions` and `revisionLimitHit` are serialized in `SerializedAgentSession` and restored on session rehydration.

---

## Why Serial Execution?

Parallel execution causes:
- Race conditions in file modifications
- Context inconsistency between agents
- Non-deterministic outputs
- Debugging nightmares

Serial execution provides:
- Predictable order of operations
- Clear causal chain
- Reproducible results
- Easy debugging

**Correctness > Speed**

---

## Why QA Per Task?

QA at the end causes:
- Accumulated bugs
- Cascading failures (Task 3 builds on buggy Task 2)
- Massive rework
- Lost context on what each task was supposed to do

QA per task provides:
- Immediate feedback
- Issues fixed while context is fresh
- No bug accumulation
- Clear task boundaries

### v6.9.0 Quality Gates (6 New Gates)

v6.9.0 "Quality & Anti-Slop Tooling" adds 6 automated gates to the pre-reviewer pipeline. v6.10.0 adds parallel batch execution for faster QA gates:

| Gate | Purpose | Local-Only |
|------|---------|------------|
| `syntax_check` | Tree-sitter parse validation across 20 languages | ✅ |
| `placeholder_scan` | Anti-slop detection for TODO/FIXME/stubs | ✅ |
| `sast_scan` | Static security analysis with 63+ rules | ✅ |
| `sbom_generate` | CycloneDX SBOM generation for dependencies | ✅ |
| `build_check` | Build/typecheck verification | ✅ |
| `pre_check_batch` | Parallel verification batch (4x faster) | ✅ |
| `quality_budget` | Maintainability threshold enforcement | ✅ |

**Local-Only Guarantee**: All v6.9.0 gates run without Docker, network connections, external APIs, or cloud services. Optional enhancement via Semgrep (if already on PATH).

---

## Why Persistent Files?

Session-only memory causes:
- Lost progress on session end
- No way to resume projects
- Re-explaining context every time
- No institutional knowledge

Persistent `.swarm/` files provide:
- Resume any project instantly
- Knowledge transfer between sessions
- Audit trail of decisions
- Cached SME guidance (no re-asking)

---

## Hooks System

The hooks system is the foundation of v5.1.x+, extended in v6.0.0 with config-aware hint injection. All features are built as hook handlers registered on OpenCode's Plugin API.

### Core Utilities

- **`safeHook(handler)`** — Wraps any hook handler in a try/catch. Errors are logged at warning level; the original payload is returned unchanged. This ensures no hook can crash the plugin.
- **`composeHandlers<I,O>(...handlers)`** — Composes multiple handlers for the same hook type into a single handler. Runs handlers sequentially on shared mutable output. Each handler is individually wrapped in `safeHook`.
- **`readSwarmFileAsync(directory, filename)`** — Reads `.swarm/` files using `Bun.file().text()`. Returns empty string on missing files.
- **`estimateTokens(text)`** — Conservative token estimation: `Math.ceil(text.length * 0.33)`.

### Hook Registration Table

| Hook Type | Handler | Purpose |
|-----------|---------|---------|
| `experimental.chat.messages.transform` | `composeHandlers(pipelineTracker, contextBudget, ccCommandInterceptHook)` | Pipeline logging + token budget warnings; progressive task disclosure; deliberation preamble injection; tier-based behavioral prompt trimming; CC command interception (hard-block /reset, soft-correct /plan, log HIGH severity) |
| `experimental.chat.system.transform` | `systemEnhancerHook` | Inject phase/task/decisions + cross-agent context; reviewer receives semantic AST diff summary with blast radius (consumers count) from `buildSemanticDiffBlock()` |
| `experimental.session.compacting` | `compactionHook` | Enrich compaction with plan.md + context.md data |
| `command.execute.before` | `safeHook(commandHandler)` | Handle `/swarm` slash commands |
| `tool.execute.before` | `safeHook(activityHooks.toolBefore)` | Track tool usage per agent; append written file paths to `modifiedFilesThisCoderTask`; reset tracking on coder delegation |
| `tool.execute.after` | `safeHook(activityHooks.toolAfter)` | Record tool results + trigger flush; advance per-task state machine on gate completions; populate `lastGateOutcome`; check scope containment after coder task; set `lastScopeViolation` on drift |
| `chat.message` | `safeHook(delegationHandler)` | Track active agent per session; extract FILE: directives into `declaredCoderScope`; advance state to `coder_delegated` on new coder delegation |

### Composition Constraint

The OpenCode Plugin API allows **one handler per hook type**. When multiple features need the same hook type (e.g., pipeline-tracker and context-budget both use `experimental.chat.messages.transform`), they must be composed via `composeHandlers()` into a single registered handler.

---

## Intelligence & Audit Tools (v6.5)

Five new tools extend the architect's decision-making capabilities with intelligence gathering and QA auditing, plus a framework detection layer for first-class framework-specific tooling.

### `todo_extract` — Annotation Scanner
Extracts `TODO`, `FIXME`, and `HACK` annotations across the codebase using regex matching and file discovery (Node.js native glob for cross-platform safety).

**Usage**: Phase 0 (resume check) or Phase 2 (discovery) to identify pre-existing work items and prioritize planning.

**Input**: `paths` (directory whitelist), `tags` (annotation types), `exclude` (directory patterns)  
**Output**: Structured JSON with file, line, tag, and content for each annotation

**Safety**: Validates paths against workspace root, rejects shell metacharacters, enforces file size limits

### `evidence_check` — Completeness Auditor
Audits completed tasks in `.swarm/evidence/` against required evidence types (review, test, diff, approval) and ensures a valid retrospective evidence bundle exists before a phase can be completed.

**Usage**: Phase 6 (phase complete) to verify every task has sufficient QA artifacts

**Input**: Task ID pattern (wildcard support)  
**Output**: JSON with per-task evidence status, missing types, and overall completeness score

**Safety**: Validates task ID format (N.M, N.M.P, retro-N, or internal tool IDs), skips symlinks, reads JSON with size limits

### `check_gate_status` — Task Gate Status Query
Read-only tool to query the gate status of a specific task. Reads `.swarm/evidence/{taskId}.json` and EvidenceBundle entries and returns structured JSON describing which gates have passed, which are missing, and the overall task status.

**Usage**: Any phase to check task completion status without mutating evidence

**Input**: `task_id` (task identifier in N.M, N.M.P, retro-N format, or internal tool ID like "sast_scan", "quality_budget", etc.)  
**Output**: JSON with `taskId`, `status` (all_passed|incomplete|no_evidence), `required_gates`, `passed_gates`, `missing_gates`, `gates` map, `message`, `todo_scan` (advisory TODO count if available), and `secretscan_verdict` (v6.33)

**Secretscan verdict (v6.33)**: The tool now scans EvidenceBundle entries for `secretscan` type evidence using the `isSecretscanEvidence` type guard. When secretscan entries are found, it reports:
- `pass` — No secrets found (verdict: pass, approved, or info)
- `fail` — Secrets detected (verdict: fail or rejected), status becomes `incomplete` and task is BLOCKED
- `not_run` — No secretscan evidence found for this task

**Safety**: Validates task ID format against three accepted patterns (canonical N.M or N.M.P numeric format, retrospective format retro-N, or internal tool IDs like sast_scan/quality_budget/syntax_check/placeholder_scan/sbom_generate/build/secretscan), enforces path containment within workspace `.swarm/evidence/` directory, reads-only (no writes)

### `pkg_audit` — Vulnerability Scanner
Wraps `npm audit`, `pip-audit`, `cargo audit`, and `composer audit` via Bun.spawn to identify security vulnerabilities in project dependencies.

**Usage**: Phase 2 (discovery) or Phase 6 (phase complete) to scope security risk and feed results to reviewer

**Input**: `ecosystem` (npm|pip|cargo|composer), `days` (vulnerability age), `top_n` (limit results)  
**Output**: Structured CVE data with severity, patched versions, and advisory URLs

**Safety**: Validates enum args strictly, bounds-checks integers (1-365 days, 1-100 results), enforces timeout via Promise.race

### `complexity_hotspots` — Risk Mapper
Combines cyclomatic complexity analysis with git churn metrics to identify high-risk modules before implementation.

**Usage**: Phase 0/2 (early warning) or Phase 6 (post-implementation assessment) to flag modules needing stricter QA

**Input**: `paths` (file patterns), `metrics` (complexity|churn|both)  
**Output**: Ranked list of risky files with complexity score, recent commits, and risk level

**Safety**: Uses Bun.spawn for git commands (not shell pipes), parses output in JavaScript, cross-platform path handling

### `schema_drift` — API Contract Auditor
Compares OpenAPI specification files against actual route implementations to surface undocumented routes and phantom spec paths.

**Usage**: Phase 6 (when API routes were modified) to catch documentation drift before release

**Input**: `spec_file` (path to OpenAPI JSON/YAML), `routes_dir` (implementation directory)  
**Output**: Drift report with missing implementations, extra routes, and parameter mismatches

**Safety**: Validates spec file extension whitelist and size limits (<10MB), uses lstatSync to skip symlinks, YAML parsing with regex `g` flag for multi-line patterns

### `doc_scan` + `doc_extract` — Two-Pass Documentation Discovery

Implements a two-pass progressive disclosure for documentation: Pass 1 indexes docs at plan time, Pass 2 extracts relevant constraints at task start.

#### Pass 1: `doc_scan` — Documentation Indexer

Scans project documentation files and builds an index manifest at `.swarm/doc-manifest.json`.

**Usage**: Phase 4 (PLAN mode) to build documentation index before tasks begin

**Input**: `force` (optional boolean, force re-scan even if cache is valid)  
**Output**: JSON with `success`, `files_count`, `cached`, and full `manifest` object

**Manifest schema**:
```typescript
interface DocManifest {
  schema_version: 1;
  scanned_at: string;        // ISO timestamp
  files: DocManifestFile[];  // Sorted by path
}

interface DocManifestFile {
  path: string;     // Relative to project root
  title: string;    // First # heading or filename
  summary: string;  // First non-empty paragraph (max 200 chars)
  lines: number;    // Total line count
  mtime: number;   // fs.statSync().mtimeMs for cache invalidation
}
```

**Discovery patterns**: Uses `doc_patterns` from `DocsConfigSchema` plus extras (`ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md`, `.github/*.md`, `doc/**/*.md`). Skips `node_modules`, `.git`, `.swarm`, test files, and type definitions.

**Caching**: mtime-based — only re-scans if any indexed file has changed since last scan.

#### Pass 2: `doc_extract` — Constraint Extractor

Reads the manifest, scores docs against task context using Jaccard bigram similarity, and extracts actionable constraints into `.swarm/knowledge.jsonl`.

**Usage**: Phase 5 (EXECUTE mode) at task start to load relevant documentation constraints

**Input**: `task_files` (array of file paths), `task_description` (string)  
**Output**: JSON with `success`, `extracted` count, `skipped` count, and per-doc `details` with score and constraints

**Algorithm**:
1. Read `.swarm/doc-manifest.json` (or generate via `doc_scan` if missing)
2. Build task context from `task_files` + `task_description`
3. Compute Jaccard bigram similarity between task context and each doc's `{path, title, summary}`
4. For docs with score > 0.1 relevance threshold, read full content and extract constraints
5. Extract lines matching constraint patterns: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `DO NOT`, `ALWAYS`, `NEVER`, `REQUIRED`; or bullet points with action words
6. Dedup against existing `.swarm/knowledge.jsonl` entries via `findNearDuplicate` (0.6 similarity threshold)
7. Append non-duplicate constraints as `SwarmKnowledgeEntry` objects

**Constraints**: Max 5 per document, 15-200 characters each, markdown stripped.

### `framework_detector` — Laravel Framework Detection (Phase 3)

Detects Laravel projects via multi-signal logic in `src/lang/framework-detector.ts`. Requires 2-of-3 signals for a positive detection:

| Signal | Check |
|--------|-------|
| `artisan_file` | `artisan` CLI script exists at project root |
| `laravel_dep` | `laravel/framework` present in `composer.json` |
| `app_config` | `config/app.php` exists |

**Usage**: During discovery (Phase 2) or before test command resolution, to activate Laravel-specific tooling overlays.

**Output**:
```typescript
interface LaravelDetectionSignals {
  hasArtisanFile: boolean;
  hasLaravelDep: boolean;
  hasAppConfig: boolean;
  signals: ('artisan_file' | 'laravel_dep' | 'app_config')[];
  detected: boolean;  // true when 2+ signals present
}

interface LaravelCommandOverlay {
  test: string;           // "php artisan test"
  lint: string[];         // ["vendor/bin/pint", "vendor/bin/php-cs-fixer fix"]
  analyze: string[];       // ["vendor/bin/phpstan analyse", "vendor/bin/phpstan analyse --memory-limit=1G"]
  audit: string;          // "composer audit --locked --format=json"
}
```

**SAST rules active for Laravel projects**: `sast/php-laravel-sql-injection`, `sast/php-laravel-mass-assignment`, `sast/php-laravel-destructive-migration`

**Common Security Patterns

All five tools follow strict security practices:
- **Path validation**: `path.resolve()` + `startsWith(workspaceRoot + path.sep)` prevents traversal bypass
- **Command execution**: Bun.spawn with array args (never string concat) to prevent shell injection
- **Timeout protection**: Promise.race on all async operations to prevent hangs
- **Input validation**: Enum/range checks on all user-supplied arguments
- **File access**: Node.js native fs (not shell grep/find) for cross-platform safety

---

## Context Pruning

The context pruning system now incorporates several new controls introduced in v6.14.12:

- **Provider‑aware model limits** – token limits are looked up per model via `context_budget.model_limits` (e.g., a higher limit for Claude Sonnet). This allows the system to adapt the budget based on the active provider.
- **Priority‑based pruning tiers** – messages are classified using the `MessagePriority` tiers (CRITICAL, HIGH, MEDIUM, LOW, DISPOSABLE). Lower‑priority messages are removed first when the token budget is exceeded.
- **Agent‑switch enforcement** – when `enforce_on_agent_switch` is true, a hard context reset is triggered whenever the active agent changes (e.g., from `explorer` to `coder`).
- **Tool‑output masking** – large tool outputs are masked/truncated once they exceed `tool_output_mask_threshold` tokens, preventing budget overruns.

These enhancements work together to keep the architect’s context within limits while preserving the most important information.

Context pruning manages the architect's context window to prevent overflow.

### Token Budget Tracker

Registered on `experimental.chat.messages.transform` (composed with pipeline-tracker):
1. Estimates total tokens across all message parts using `estimateTokens()`
2. Looks up model-specific token limit from `context_budget.model_limits` config (default: 128,000)
3. At `warn_threshold` (default 70%): injects `[CONTEXT WARNING]` message
4. At `critical_threshold` (default 90%): injects `[CONTEXT CRITICAL]` message

### Compaction Enhancement

Registered on `experimental.session.compacting`:
- Reads `.swarm/plan.md`: extracts current phase + incomplete tasks
- Reads `.swarm/context.md`: extracts decisions + patterns
- Injects these as compaction context strings (max 500 chars each)
- When `.swarm/summaries/` exists and contains files:
  - Injects `[CONTEXT OPTIMIZATION]` hint: instructs LLM to replace large tool output blocks (bash, test_runner, lint, diff) with retrieve references, preserving tool name, exit status, and errors
  - Injects `[STORED OUTPUTS]` count showing how many tool outputs are stored
- Guides OpenCode's built-in compaction to preserve swarm-relevant context

### System Prompt Enhancement

Registered on `experimental.chat.system.transform`:
- Injects current phase + task from plan.md (~200 chars)
- Injects top 3 most recent decisions from context.md
- Keeps agents focused even after conversation history is compacted
- Respects `max_injection_tokens` budget (default: 4,000 tokens)
- Priority ordering: phase → task → decisions → agent context
- Lower-priority items dropped when budget is exhausted
- **v6.0.0**: Injects config override hints for `always_security_review` and `integration_analysis.enabled` when non-default values are detected

---

## Evidence System

The evidence system persists verifiable execution artifacts per task.

### Evidence Types

| Type | Fields | Purpose |
|------|--------|---------|
| `review` | risk, issues[] | Reviewer findings |
| `test` | tests_passed, tests_failed | Test engineer results |
| `diff` | files_changed[], additions, deletions | Code change summary |
| `approval` | (base fields only) | Explicit approval record |
| `note` | (base fields only) | Free-form annotation |
| `secretscan` | findings_count, scan_directory, files_scanned, skipped_files | Secret scan results (v6.33) |
| `mutation-gate` | verdict, killRate, adjustedKillRate, summary, survivedMutants[] | Phase-close mutation testing gate results — written by `write_mutation_evidence` tool; blocks phase completion when verdict is `fail` (v6.68+) |

### Storage

```
.swarm/evidence/
├── 1.1/
│   └── evidence.json    # EvidenceBundleSchema (array of entries)
└── 2.3/
    ├── evidence.json
    └── diff.patch       # Optional raw diff
```

### Security

- Task IDs are sanitized: regex `^[\w-]+(\.[\w-]+)*$`, rejects `..`, null bytes, control chars
- Two-layer path validation: sanitize task ID + `validateSwarmPath()` on full path
- Size limits: JSON 500KB, diff.patch 5MB, total per task 20MB
- Atomic writes via temp+rename pattern

### Retention

Configurable via `evidence` config:
- `max_age_days`: Archive evidence older than N days (default: 90)
- `max_bundles`: Maximum evidence bundles before auto-archive (default: 1000)
- `auto_archive`: Enable automatic archiving (default: false)

---

## Quality Gates (v6.9.0)

Six new automated gates enforce code quality before human review. All gates run locally without Docker or network dependencies.

### Gate Overview

| Gate | Function | Fail Action |
|------|----------|-------------|
| `syntax_check` | Tree-sitter parse validation | Return to coder for fix |
| `placeholder_scan` | Detect TODO/FIXME/stubs | Return to coder to complete |
| `sast_scan` | Static security analysis (66 rules) | Return to coder for fix |
| `sbom_generate` | CycloneDX SBOM generation | Log for audit trail |
| `build_check` | Build/typecheck verification | Return to coder for fix |
| `pre_check_batch` | Parallel verification (v6.10.0) | Return to coder for fix |
| `quality_budget` | Maintainability enforcement | Return to coder or adjust limits |

### syntax_check - Parse Validation

Uses Tree-sitter grammars for 20 languages:
- TypeScript/JavaScript
- Python
- Rust
- Go
- Java
- C/C++
- Ruby
- PHP
- C#

**Fail condition**: Parse errors, unclosed brackets, invalid syntax
**Resolution**: Coder fixes syntax errors before review

### placeholder_scan - Anti-Slop Detection

Detects patterns indicating incomplete implementation:
- `TODO`, `FIXME`, `XXX`, `HACK` comments
- Placeholder strings (`placeholder`, `stub`, `implement me`)
- Empty function bodies
- Hardcoded dummy values

**Fail condition**: Any placeholder pattern in changed files
**Resolution**: Coder completes implementation before review

### sast_scan - Static Security Analysis

66+ security rules across 9 languages covering:
- SQL injection vectors (including Laravel-specific `DB::raw()` concatenation)
- Path traversal patterns
- Hardcoded secrets
- Insecure crypto usage
- XSS vulnerabilities
- Command injection
- Laravel-specific: mass-assignment via empty `$guarded`, destructive migrations without rollback

**Offline operation**: Built-in rule engine, no external API calls
**Optional enhancement**: Semgrep Tier B rules if available on PATH
**Fail condition**: High/critical severity findings
**Resolution**: Coder fixes security issues before review

### sbom_generate - Dependency Tracking

Generates CycloneDX SBOMs from manifest files:
- `package.json` + `package-lock.json` (npm)
- `requirements.txt`, `Pipfile`, `poetry.lock` (Python)
- `Cargo.toml` + `Cargo.lock` (Rust)
- `go.mod` + `go.sum` (Go)
- `pom.xml`, `build.gradle` (Java)
- `Gemfile.lock` (Ruby)
- `composer.lock` (PHP)
- `.csproj` + `packages.lock.json` (C#)

**Output**: CycloneDX JSON format
**Purpose**: Security auditing, license compliance
**Fail condition**: None (informational gate)

### build_check - Compilation Verification

Runs repository-native build commands:
- `npm run build` / `tsc --noEmit` (TypeScript)
- `cargo build` / `cargo check` (Rust)
- `go build` (Go)
- `javac` / Maven / Gradle (Java)
- `python -m py_compile` (Python)

**Fail condition**: Build errors, type check failures
**Resolution**: Coder fixes build errors before review

### quality_budget - Maintainability Enforcement

Enforces configurable thresholds on code changes:

| Budget | Default | Description |
|--------|---------|-------------|
| `max_complexity_delta` | 5 | Maximum cyclomatic complexity increase |
| `max_public_api_delta` | 10 | Maximum new public API surface |
| `max_duplication_ratio` | 0.05 | Maximum code duplication ratio (5%) |
| `min_test_to_code_ratio` | 0.3 | Minimum test-to-code ratio (30%) |

**Fail condition**: Budget exceeded
**Resolution**: Refactor code or adjust budget thresholds

### pre_check_batch - Parallel Verification (v6.10.0)

Runs four verification tools in parallel for 4x faster gate execution:

| Tool | Purpose | Gate Type |
|------|---------|-----------|
| `lint:check` | Code quality verification | Hard gate |
| `secretscan` | Secret/credential detection | Hard gate |
| `sast_scan` | Static security analysis | Hard gate |
| `quality_budget` | Maintainability metrics | Hard gate |

**Parallel Execution**:
- Uses `p-limit` with max 4 concurrent operations
- 60-second timeout per tool
- 500KB combined output limit
- Individual failures don't cascade

**Return Value**:
```json
{
  "gates_passed": true,
  "lint": { "ran": true, "result": {}, "duration_ms": 1200 },
  "secretscan": { "ran": true, "result": {}, "duration_ms": 800 },
  "sast_scan": { "ran": true, "result": {}, "duration_ms": 2500 },
  "quality_budget": { "ran": true, "result": {}, "duration_ms": 400 },
  "total_duration_ms": 3200
}
```

**Configuration**:
```json
{
  "pipeline": {
    "parallel_precheck": true  // default: true
  }
}
```

**Fail condition**: Any hard gate fails (lint errors, secrets found, SAST findings, budget exceeded)
**Resolution**: Fix specific failures identified in tool results and retry

### Local-Only Guarantee

All v6.9.0 quality gates:
- ✅ Run entirely locally
- ✅ No Docker containers required
- ✅ No network connections
- ✅ No external APIs
- ✅ No cloud services

Optional enhancement:
- Semgrep CLI (if already installed on PATH)

---

## Slash Commands

Twelve commands registered under `/swarm`:

| Command | Description |
|---------|-------------|
| `/swarm status` | Shows current phase, task progress (completed/total), and agent count |
| `/swarm plan` | Displays full plan.md content |
| `/swarm plan N` | Displays only Phase N from plan.md |
| `/swarm agents` | Lists all registered agents with model, temperature, read-only status, and guardrail profiles |
| `/swarm history` | View completed phases with status icons |
| `/swarm config` | View current resolved plugin configuration |
| `/swarm diagnose` | Health check for .swarm/ files, plan structure, and evidence completeness |
| `/swarm export` | Export plan and context as portable JSON |
| `/swarm reset --confirm` | Clear swarm state files (with safety gate) |
| `/swarm evidence [task]` | View evidence bundles for a task or list all tasks with evidence |
| `/swarm archive [--dry-run]` | Archive old evidence bundles with retention policy |
| `/swarm benchmark` | Run performance benchmarks and display metrics |
| `/swarm retrieve [id]` | Retrieve auto-summarized tool outputs by ID |

### Implementation

Commands are registered in two steps:
1. **`config` hook** — Adds `swarm` command to OpenCode's command registry
2. **`command.execute.before` hook** — Intercepts `/swarm` commands and routes to handlers

The command handler uses a factory pattern: `createSwarmCommandHandler(directory, agents)` creates a closure over the project directory and agent definitions, returning a handler function.

---

## Context Engineering (v6.21 Phase 4)

Four features added to `delegation-gate.ts` and the `guardrails/` submodule suite (`tool-before.ts`, `messages-transform.ts`, `file-authority.ts`) reduce context waste and improve model decision quality.

### Progressive Task Disclosure

When the last user message contains more than 5 task lines (matching `- [ ]` or `- [x]` with task IDs), `messagesTransform` trims the list to a context window: the current task (from `session.currentTaskId`), 2 tasks before it, and 3 tasks after it. All other message content is preserved. A `[Task window: showing N of M tasks]` comment marks the trim point. If no `currentTaskId` is set, no trimming occurs.

### Deliberation Preamble

At the end of every `messagesTransform` invocation, a preamble is prepended to the last user message:

```
[Last gate: {tool} {result} for task {taskId}]
[DELIBERATE: Before proceeding — what is the SINGLE next task? What gates must it pass?]
```

The preamble is sourced from `session.lastGateOutcome`. On first invocation (`lastGateOutcome` is null), an introductory variant fires instead:

```
[DELIBERATE: Identify the first task from the plan. What gates must it pass before marking complete?]
```

### Low-Capability Model Detection

`src/config/constants.ts` exports:

- `LOW_CAPABILITY_MODELS: string[]` — Substrings that identify smaller models: `'mini'`, `'nano'`, `'small'`, `'free'`
- `isLowCapabilityModel(modelId: string): boolean` — Returns `true` if `modelId` (case-insensitive) contains any entry in `LOW_CAPABILITY_MODELS`. Uses `session.activeModel` as the input, the same field used for rate limiting in `model-limits.ts`.

### Tier-Based Behavioral Prompt Trimming

Three `<!-- BEHAVIORAL_GUIDANCE_START --> … <!-- BEHAVIORAL_GUIDANCE_END -->` marker pairs wrap verbose behavioral sections in `src/agents/architect.ts`:
1. The BATCHING DETECTION section
2. The ARCHITECT CODING BOUNDARIES section
3. The QA gate behavioral description paragraphs

When `isLowCapabilityModel(session.activeModel)` returns `true`, `guardrails/messages-transform.ts messagesTransform` strips all text between every marker pair (inclusive) and replaces each removed block with `[Enforcement: programmatic gates active]`. If `session.activeModel` is null or undefined, the prompt is left unchanged.

**Rationale:** Smaller models benefit from shorter, more directive prompts. The programmatic enforcement mechanisms (state machine, hard blocks, scope containment) provide equivalent safety guarantees without verbose behavioral instructions consuming context.

---

## Structural Scope Declaration (v6.21 Phase 5)

### `declare_scope` Tool

Architect-only tool that pre-declares which files a coder delegation is allowed to modify.

**Input:**
```typescript
{
  taskId: string,          // N.M or N.M.P format
  files: string[],         // file paths the coder may modify
  whitelist?: string[],    // additional allowed paths
  working_directory?: string
}
```

**Validation:**
- `taskId` must match `N.M` or `N.M.P` format
- `files` must be non-empty; no null bytes, path traversal (`..`), or overly long paths
- `working_directory` must exist and contain `.swarm/plan.json`
- `taskId` must exist in the plan; task must not already be in `'complete'` state

**On success:** Sets `session.declaredCoderScope = mergedFiles` (files + whitelist) and `session.lastScopeViolation = null` on ALL active architect sessions. Returns `{ success: true, taskId, fileCount }`.

**On failure:** Returns structured error with `{ success: false, message, errors[] }`.

**Automatic alternative:** `delegation-gate.ts` extracts FILE: directive values from any coder delegation envelope and stores them as `session.declaredCoderScope` automatically. An explicit `declare_scope` call is only needed when scope must be declared before the delegation text is composed.

### Scope Containment Enforcement

**Tracking (`guardrails/tool-before.ts`):**
- When the architect uses any file-modifying tool (write, edit, patch, create_file, insert, replace), the target file path is appended to `session.modifiedFilesThisCoderTask`.
- When a coder Task delegation is dispatched, `modifiedFilesThisCoderTask` resets to `[]`.

**Checking (`guardrails/index.ts` toolAfter):**
- After a coder Task delegation completes, `modifiedFilesThisCoderTask` is compared against `declaredCoderScope`.
- If `declaredCoderScope` is non-null and more than 2 files in `modifiedFilesThisCoderTask` are outside the declared scope: `session.lastScopeViolation` is set to a message listing the undeclared file paths.
- `modifiedFilesThisCoderTask` resets to `[]` after the check.

**Warning injection (`guardrails/messages-transform.ts`):**
- If `session.scopeViolationDetected` is set, a scope violation warning is injected into the next architect message.
- The flag clears immediately (before nested conditionals) to prevent stale state across turns.

---

## Agent Awareness

Agent awareness tracks what each agent is doing and shares relevant context across agents via system prompts. The architect remains the sole orchestrator — there is no direct inter-agent communication.

### Shared State

`src/state.ts` exports a module-scoped singleton (`swarmState`) with:
- `activeAgent: Map<sessionId, agentName>` — Which agent is active in each session (updated by chat.message hook)
- `agentSessions: Map<sessionId, AgentSessionState>` — Per-session guardrail tracking. Key fields:
  - `toolCallCount`, `startTime`, `delegationActive` — Guardrail counters
  - `taskWorkflowStates: Map<string, TaskWorkflowState>` — Per-task state machine. States: `'idle' | 'coder_delegated' | 'pre_check_passed' | 'reviewer_run' | 'tests_run' | 'complete'`. Transitions are forward-only; `complete` can only be reached from `tests_run`.
  - `lastGateOutcome: { gate, taskId, passed, timestamp } | null` — Most recent gate result, populated by `guardrails/index.ts` toolAfter. Used for deliberation preamble injection in Phase 4 context engineering.
  - `declaredCoderScope: string[] | null` — File paths from the coder delegation FILE: directives or explicit `declare_scope` tool call (Phase 5). Null means no scope has been declared.
  - `lastScopeViolation: string | null` — Last scope containment violation message (Phase 5). Set when coder modifies >2 files outside declared scope; cleared after warning is injected.
  - `modifiedFilesThisCoderTask: string[]` — File paths the architect has written during the current coder task (Phase 5). Reset to `[]` when the next coder delegation starts.
  - `scopeViolationDetected?: boolean` — One-shot flag (Phase 5). Set when a scope violation is found; cleared immediately after the warning is injected into the next architect message.
  - `model_fallback_index: number` — Current index into the fallback_models array (v6.33). Incremented on transient model failure; resets to 0 on success.
  - `modelFallbackExhausted: boolean` — Flag set when all fallback models have been exhausted (v6.33). Prevents advisory spam on consecutive transient errors.
- `eventCounter: number` — Tracks events for flush threshold
- `flushLock: Promise | null` — Serializes context.md writes
- `resetSwarmState()` — Clears all state (used in tests)

State machine helpers: `advanceTaskState(session, taskId, newState)` enforces forward-only transitions (throws `INVALID_TASK_STATE_TRANSITION` on illegal transitions); `getTaskState(session, taskId)` returns `'idle'` for unknown tasks.

Scope containment helper: `isInDeclaredScope(filePath, scopeEntries)` in `guardrails/tool-before.ts` resolves both the candidate path and each scope entry with `path.resolve()` then checks containment with `path.relative()`. This handles directory entries correctly (a scope entry of `src/` covers all files below it) without brittle string `includes()` matching.

The module has **zero imports** — it's pure TypeScript with no project dependencies.

### Stale Delegation Detection

When a subagent finishes and returns control to the architect, there's a race condition between the `chat.message` hook (which updates `activeAgent`) and the `tool.execute.before` hook (which checks guardrails). To prevent the architect from inheriting subagent limits during this transition:

1. **Stale delegation window:** If `lastToolCallTime` is >10 seconds old, the session is considered stale and reverts to architect
2. **Delegation active flag:** If `delegationActive=false` (subagent finished), immediately revert to architect
3. **Early exemption:** Three name-based architect checks in the guardrails hook provide defense-in-depth

The 10-second window is tight enough to prevent architect misidentification but loose enough to allow slow subagent operations (file I/O, network).

### Activity Tracking Flow

```
chat.message hook                tool.execute.before hook         tool.execute.after hook
─────────────────               ────────────────────────         ───────────────────────
│                                │                                │
├─ Extract agent name            ├─ Read active agent from        ├─ Record tool result
│  (strip prefix:                │  swarmState                    │  (success heuristic)
│   paid_, local_,               ├─ Log: "agent X using          ├─ Increment event counter
│   mega_, default_)             │  tool Y"                       ├─ If counter >= 20:
├─ Update activeAgent            │                                │  └─ Flush to context.md
│  map                           │                                │     (promise-based lock)
│                                │                                │
```

### Cross-Agent Context Injection

The system-enhancer reads the `## Agent Activity` section from context.md and maps agent names to context labels:
- `coder` → implementation context
- `reviewer` → review findings
- `test_engineer` → test results
- Other agents → general context

Injected text is truncated to `hooks.agent_awareness_max_chars` (default: 300 characters).

---

## v6.7 Background Automation Framework

**v6.7 is GUI-first and background-first:** Slash commands remain the primary control surface, but background automation provides autonomous operation when enabled.

### Automation Modes

Three modes control background-first rollout:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `manual` | No background automation, all actions via slash commands (default) | Conservative rollout, full control |
| `hybrid` | Background automation for safe operations, slash commands for sensitive ones | Gradual feature rollout |
| `auto` | Full background automation (target state) | Future production use |

**Default:** `manual` for backward compatibility. Enable automation via config.

### Per-Capability Feature Flags

All v6.7 automation features are gated behind explicit feature flags (all default `false`):

| Feature Flag | Description | Security |
|--------------|-------------|----------|
| `plan_sync` | Plan auto-heal: regenerate plan.md from canonical plan.json when out of sync | Safe - read-only regeneration |
| `phase_preflight` | Phase-boundary preflight checks before agent execution | Safe - validation-only |
| `config_doctor_on_startup` | Config Doctor runs on startup to validate/fix configuration | Moderate - auto-fix requires explicit opt-in |
| `config_doctor_autofix` | Auto-fix mode for Config Doctor (requires config_doctor_on_startup) | **Safety: Defaults to false** - autofix requires explicit opt-in |
| `evidence_auto_summaries` | Generate automatic summaries for evidence bundles | Safe - read-only aggregation |
| `decision_drift_detection` | Detect drift between planned and actual decisions | Moderate - drift detection only |

### Core Automation Components

#### 1. Event Bus (`AutomationEventBus`)

Typed event system for internal automation events. Events:
- Queue events (`enqueued`, `dequeued`, `completed`, `failed`, `retry scheduled`)
- Worker events (`started`, `stopped`, `error`)
- Circuit breaker events (`opened`, `half-open`, `closed`, `callSuccess`, `callFailure`)
- Loop protection events (`triggered`)
- Preflight events (`requested`, `triggered`, `skipped`, `completed`)
- Phase boundary events (`detected`, `checked`)
- Task events (`completed`)
- Evidence summary events (`generated`, `error`)

All events include timestamp, payload, and optional source identifier.

#### 2. Queue (`AutomationQueue`)

Lightweight in-process queue with:
- Priority levels: `critical` > `high` > `normal` > `low`
- FIFO ordering within priority
- Exponential backoff retry (configurable max)
- Max queue size protection (default 1000)
- Retry metadata tracking (attempts, next attempt time, backoff)

#### 3. Worker Manager (`WorkerManager`)

Lifecycle manager for background workers:
- Register workers with handler functions
- Configurable concurrency (default 1)
- Auto-start support
- Processing loop with idle detection
- Statistics tracking (processed count, error count, queue size)

#### 4. Circuit Breaker (`CircuitBreaker`)

Fault tolerance primitive:
- States: `closed` (normal) → `open` (fail fast) → `half-open` (testing recovery)
- Configurable failure threshold (default 5) and reset timeout (default 30s)
- Call timeout support (default 10s)
- Success threshold for half-open → closed (default 3)

Prevents cascading failures during background automation.

#### 5. Loop Protection (`LoopProtection`)

Infinite loop prevention:
- Tracks operation frequency over time window (default 10s)
- Configurable max iterations (default 5)
- Operation key for tracking specific operations
- Automatic detection and abort on threshold exceed

#### 6. Status Artifact (`AutomationStatusArtifact`)

Passive status writer for GUI visibility:
- Writes to `.swarm/automation-status.json`
- Tracks mode, capabilities, phase, triggers, outcomes
- GUI-friendly summary with readable status text

### Plan Sync Auto-Heal

**v6.7 Task 5.1:** Automatic plan.json ↔ plan.md synchronization.

#### Auto-Heal Flow

```
loadPlan(directory):
  1. Try to load plan.json
     ├─ VALID → Check if plan.md in sync
     │  ├─ In sync → Return plan
     │  └─ Out of sync → Auto-regenerate plan.md from plan.json
     │
     └─ INVALID → Try to migrate from plan.md
        ├─ plan.md exists → Migrate, save both files, return plan
        └─ plan.md doesn't exist → Fall through
  2. Try to load plan.md only (no auto-migration)
     ├─ Exists → Return migrated plan
     └─ Doesn't exist → Fall through
  3. Neither exists → Return null
```

#### Deterministic Hashing

Content hash uses natural numeric sorting for task IDs:
- `"1.2"` < `"1.10"` (not `"1.2" < "1.10"`)
- Example: `1.1, 1.2, 1.10, 1.11, 2.1` (sorted correctly)
- Hash stored in plan.md header as `<!-- PLAN_HASH: <hash> -->`

#### Atomic Writes

Plan.json writes use temp+rename pattern for atomicity:
1. Write to `plan.json.tmp.{timestamp}`
2. Atomic rename to `plan.json`
3. Derive plan.md with hash comment

### Services (Extracted from Commands)

#### Preflight Service

Validates project state before agent execution:
- Checks plan completeness
- Validates evidence requirements per task
- Detects blockers and missing dependencies
- Returns actionable findings with severity levels

**Gated behind:** `automation.capabilities.phase_preflight`

#### Config Doctor

Startup service that validates and fixes configuration:
- **Extended validation coverage** — validates all 62+ top-level schema keys with type checks for strings, booleans, numbers, and objects
- **Unknown key detection** — warns on typos with Levenshtein-based suggestions (edit distance ≤ 2)
- **Swarms hardening** — warns on empty `swarms` configuration (INFO), rejects path-traversal characters in swarm IDs (`..`, `/`, `\`, `\0`) as HIGH/ERROR
- **Deprecated field flagging** — emits INFO findings for legacy `skill_improver.model`, `skill_improver.fallback_models`, `spec_writer.model`, `spec_writer.fallback_models` with replacement guidance
- **Auto-fix inventory** — 156 range-bounded numeric keys (e.g. `max_iterations`, `qa_retry_limit`) are auto-clampable
- Classifies findings by severity (info/warn/error)
- Proposes safe auto-fixes

**Security:** Defaults to scan-only mode. Autofix requires explicit `automation.capabilities.config_doctor_autofix = true`.

**Backups:** Creates encrypted backups in `.swarm/` before auto-fix. Supports restore via `/swarm config doctor --restore <backup-id>`.

**Startup advisory:** When the doctor runs on startup (via `config_doctor_on_startup`) and finds auto-fixable issues without autofix enabled, it emits a console-visible advisory to the user suggesting `/swarm config doctor --fix`. When autofix is enabled and fixes are applied, a confirmation advisory is shown instead.

**Last-run summary:** The `/swarm config doctor` command (without `--fix`) reads the previous run artifact from `.swarm/config-doctor.json` and displays a compact summary line showing the last run timestamp, findings count, and auto-fixable count before the current findings.

#### Decision Drift Analyzer

Detects drift between planned and actual decisions:
- Stale decisions (age/phase mismatch)
- Contradictory decisions (use vs don't use, keep vs remove, etc.)
- Caches decisions from `## Decisions` section in context.md
- Returns structured drift signals for context injection

**Gated behind:** `automation.capabilities.decision_drift_detection`

#### Evidence Summary Service

Aggregates evidence per task and phase:
- Machine-readable JSON summary in `.swarm/evidence-summary.json`
- Human-readable markdown in `.swarm/evidence-summary.md`
- Per-task completion status
- Phase-level blockers (missing evidence, incomplete tasks, blocked tasks)

**Gated behind:** `automation.capabilities.evidence_auto_summaries`

### Slash Command Adapters

Commands expose service functionality without blocking UI:

| Command | Function | Security |
|---------|----------|----------|
| `/swarm preflight` | Run preflight checks on current plan | Safe - validation-only |
| `/swarm config doctor [--fix] [--restore <id>]` | Config Doctor with optional auto-fix and restore | Moderate - auto-fix opt-in |
| `/swarm doctor tools` | Tool registration coherence, AGENT_TOOL_MAP alignment, and Class 3 binary readiness check | Safe - validation-only |
| `/swarm sync-plan` | Force plan.md regeneration from plan.json | Safe - read-only |

All commands:
- Non-blocking (fire and forget for background ops)
- Async execution (don't block OpenCode UI)
- Log results to console
- Store artifacts in `.swarm/`

### GUI Visibility

`AutomationStatusArtifact` provides passive status for GUI:

```json
{
  "timestamp": 1234567890,
  "mode": "manual",
  "enabled": false,
  "currentPhase": 2,
  "lastTrigger": null,
  "pendingActions": 0,
  "lastOutcome": null,
  "capabilities": {
    "plan_sync": false,
    "phase_preflight": false,
    "config_doctor_on_startup": false,
    "config_doctor_autofix": false,
    "evidence_auto_summaries": false,
    "decision_drift_detection": false
  }
}
```

GUI uses `getGuiSummary()` for display:
- Status (Disabled / Hybrid / Auto)
- Current phase
- Last trigger time
- Pending actions count
- Last outcome (success/failure/skipped)

---

## v6.8 Enhanced Automation & Background Workers

**v6.8 builds on v6.7 with automatic execution triggers and persistent background workers.**

### Auto-Trigger System

#### Phase Monitor Hook

**`createPhaseMonitorHook()`** in `src/hooks/phase-monitor.ts`:

- Detects phase transitions in the execution pipeline
- Automatically triggers preflight checks when phase changes
- Registers on `PhaseChangeHook` event hook
- Configurable via `automation.capabilities.phase_preflight` (requires explicit enable)

#### Preflight Integration

**`createPreflightIntegration()`** wires the phase monitor into the hook chain:

```
Phase Monitor Hook → Preflight Service → Auto-trigger if phase changes
```

Benefits:
- No manual `/swarm preflight` command needed during execution
- Consistent preflight checks at every phase boundary
- Automatic blocker detection before agent execution

### Background Workers

#### Plan Sync Worker

**`PlanSyncWorker`** class in `src/background/plan-sync-worker.ts`:

**File Watching:**
- `fs.watch` on `plan.json` for real-time synchronization
- 2-second polling fallback if `fs.watch` fails (network/mount issues)

**Debouncing:**
- 300ms debounce before processing changes
- Prevents multiple rapid updates from triggering unnecessary regenerations
- Batch writes for better performance

**Overlap Lock:**
- Exclusive lock on plan.json during regeneration
- Concurrent reads during regeneration (readers/writer pattern)
- Safe shutdown with grace period

**Safe Shutdown:**
- Graceful shutdown on plugin unload
- Cancel pending operations
- Release all locks before exit

#### Evidence Summary Worker

Background service that auto-generates evidence summaries:

- Scheduled generation for long-running tasks
- Aggregates per-task evidence into phase-level summaries
- Writes to `.swarm/evidence-summary.json`
- Triggers via `/swarm evidence summary` command

### Configuration Updates

#### New Defaults

| Configuration | v6.7 Default | v6.8 Default | Reason |
|---------------|--------------|--------------|--------|
| `evidence_auto_summaries` | `false` | `true` | Long-running tasks benefit from automatic summaries |
| `plan_sync` | `false` | `true` | Auto-healing plan.json ↔ plan.md is safe and recommended |

#### Migration Path

v6.7 configs are fully compatible with v6.8:
- Set `evidence_auto_summaries: true` in config to enable automation
- Set `plan_sync: true` in config to enable background synchronization
- Previous configs remain valid (defaults preserved for disabled features)

### Testing Coverage

**808 new tests** across 6 new test files:
- `evidence-summary-init.test.ts` — Evidence summary service initialization
- `evidence-summary-init.adversarial.test.ts` — Error handling and recovery
- `evidence-summary-automation.test.ts` — Auto-generation triggers
- `phase-preflight-auto.test.ts` — Phase monitor and auto-trigger
- `plan-sync-worker.test.ts` — Worker core functionality
- `plan-sync-worker.adversarial.test.ts` — Edge cases and failures
- `plan-sync-init.test.ts` — Worker initialization

**Total:** 4008 tests across 136 files

### Integration Details

#### Hook Chain

```
Plugin Init
├── EvidenceSummaryIntegration (auto-generates summaries)
├── PhaseMonitorHook (detects phase changes)
└── PreflightIntegration (wires phase monitor to preflight)
```

#### Background Worker Registration

```
Plugin Init
└── WorkerManager
    └── Register PlanSyncWorker (auto-sync plan.json → plan.md)
```

#### Slash Command: `/swarm evidence summary`

Manual trigger for evidence summary generation:

```typescript
// Command handler in src/commands/evidence.ts
evidenceCommand.execute(async (args) => {
  await EvidenceSummaryService.generate();
  return { success: true, message: 'Evidence summary generated' };
});
```

### Benefits

**For Architects:**
- Less manual intervention during long-running tasks
- Automatic plan synchronization without refresh
- Consistent preflight checks at every phase boundary

**For Projects:**
- Resumable, maintainable execution state
- Automatic evidence aggregation
- Reduced risk of plan drift
- Comprehensive audit trail

**For Users:**
- "set it and forget it" automation
- No breaking changes to existing configs
- Clear visibility via status artifacts
- Graceful degradation on failures

---

## Recommended .swarm/ Memory Architecture (v6.14+)

Research findings (Claude Code, Windsurf, JetBrains, Trajectory Miner) support
separating `.swarm/context.md` into distinct concerns:

```
.swarm/
├── context.md          ← Human-authored rules & architecture (static, version-controlled)
├── patterns.md         ← Agent-discovered patterns (auto-updated, 200-line limit)
├── plan.json / plan.md ← Current plan state
├── evidence/
│   ├── retro-1/evidence.json   ← Phase 1 retrospective
│   ├── retro-2/evidence.json   ← Phase 2 retrospective
│   └── {task-id}/evidence.json ← Task-level evidence bundles
├── events.jsonl        ← Event log
└── telemetry.jsonl     ← Session observability (JSONL, 10MB rotation)
```

Key principles:
- Static rules (`context.md`) always override auto-learned patterns (`patterns.md`)
- Retrospectives are keyed by `retro-{phase_number}` convention
- User directives with `scope: project` are persisted to `context.md`
- Agent-discovered patterns require 2+ session frequency before persisting

> **Note:** The actual restructuring of `context.md` is deferred to v6.14. This section documents the target architecture for planning purposes.

---

## Parallelization Foundation (PR 1 — Dark)

PR 1 of the stacked parallelization release lands dark infrastructure with zero behavior change.
See [docs/archive/dev/pr1-foundation.md](archive/dev/pr1-foundation.md) for the full design note covering:
- What is dark now vs. deferred to PR 2 and PR 3
- Process-global variable audit and isolation classification
- Invariants that prove runtime behavior is unchanged
