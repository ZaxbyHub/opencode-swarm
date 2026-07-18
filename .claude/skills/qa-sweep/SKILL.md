---
name: qa-sweep
audience: swarm-plugin
description: >
  Apply when implementing features, fixing bugs, debugging errors, investigating failures,
  tracing root causes, reviewing tech debt, tracing issues, planning fixes, or completing
  any task. Enforces parallel sub-agent implementation, independent adversarial review,
  and a 95% confidence gate before stopping.
effort: high
---

## QA & Independent Review Protocol

Follow this protocol on every implementation, fix, debugging, or review task.

### Proportionality
Scale the **depth** of each phase to risk — never skip a gate for changed work,
but match its weight to the task:
- Read-only or answer-only work (explaining code, reading logs, answering a
  question) with no worktree edit: Phases 2–3 are not required; verify claims
  against the actual source before answering.
- Any worktree edit (code, tests, docs, package metadata, release notes, skill
  files): Phases 2 and 3 are mandatory. For a small, low-risk edit, one fresh
  review agent covering both the adversarial and completeness checklists is
  acceptable; for high-risk or cross-file work, keep them separate.
- High-risk work (security, auth, isolation, IPC contracts, payments,
  migrations, concurrency): full protocol, no consolidation.

This proportionality applies only to qa-sweep's own Phase 2/3 passes. When
swarm mode is enabled, the swarm-mode contract's separate independent
implementation reviewer and final critic gates apply unreduced to any
changed work — consolidation here never merges or replaces those gates.

For agent-type, model, and effort selection when spawning these sub-agents,
load the `orchestrating-subagents` skill: economize on explorers, never on
reviewers.

### If no subagent tool is available
If this protocol executes in a context without a subagent tool (`Agent` or
`Task`) — check your actual tool list rather than assuming — perform the
Phase 2/3 checklists yourself as a clearly labeled **fallback self-review**
and disclose in your report that independent review was unavailable, so the
orchestrator can re-run the gate with a real fresh agent. Never present
self-review as independent review.

### Phase 1 — Parallel Implementation
- Use parallel sub-agents to speed up independent units of work wherever possible.
- Each sub-agent must read relevant source code end-to-end before making changes.
- Reference official documentation to verify whether any behavior is intended before treating it as a bug.
- Do not trust assumptions — prove every behavior against actual code.

### Pre-implementation static-gate baseline

Before the first coder dispatch in any phase, capture a static-gate baseline so findings are scoped to the phase, not to pre-existing code:

- **Defining the pre-phase file set**: the canonical source is the file list passed to `declare_scope({ taskId, files })` (see the swarm-implement skill for the discipline). If `declare_scope` was called with the task's exact file list, that IS the pre-phase file set. If `declare_scope` was not called (e.g., the file list is not 100% obvious), use the containing directories declared in the previous call, OR fall back to the task's `files_touched` array in the plan (`save_plan` writes this). Never use the entire repository as the pre-phase file set — that defeats the point of phase scoping.
- **SAST**: if `sast_scan` is available with `capture_baseline:true`, invoke it once at phase open against the pre-phase file set. Subsequent phase-scoped scans only fail on NEW findings. If swarm tools are unavailable, document the gap in the closure report and skip the baseline capture (do not silently fall back to a project-wide scan that fires on every historical finding).
- **`placeholder_scan`**: this gate has no baseline concept — it only supports an `allow_globs` filter. Pre-configure `allow_globs` for any TODO/FIXME/HACK comments that are intentionally retained (technical debt tracked elsewhere). Do not delete real placeholders to silence the gate; add them to the allowlist.
- Re-baseline if co-change detection expands the file list after the initial baseline — a missed re-baseline will mis-attribute pre-existing findings to the phase.

### Acceptance tests first
Before running any broader test suite, run the smallest test set that covers the task's acceptance criteria. Full-suite passes can mask targeted failures when ordering or concurrency changes — exercise each FR's acceptance criterion explicitly first.

### Phase 2 — Independent Adversarial Review (Mandatory)
After implementation, spawn a FRESH sub-agent that has not participated in any prior work. Give it this directive verbatim:
> "Assume all work done by the implementing agent is incorrect until you can prove otherwise with
> absolute evidence from the actual code. The implementing agent makes frequent mistakes and tends
> to miss edge cases. Do not trust any claim without tracing it yourself. Review every change,
> test, and edge case end-to-end through the real source."

The review agent must:
- Independently trace each change end-to-end through the codebase
- Search for related issues and regressions the implementing agent may have introduced
- Verify documented behavior vs. actual code behavior
- Surface every edge case not explicitly covered

**Timing requirement:** Phase 2 must complete and all confirmed findings must be addressed **before the commit you intend as the final substantive push**. Do not defer this to "after CI passes" — CI passing on a buggy commit does not retroactively make the review optional. For high-risk work (security, isolation, IPC contracts, auth, payments), this is a hard gate with no exceptions.

### Phase 3 — Completeness Verification
Spawn a SECOND independent agent to verify original planned work vs. delivered work:
> "Assume nothing was completed correctly or fully. Map every originally planned item to actual
> code changes and verify each one independently. Do not trust the implementing agent's report."

### Stop Condition
Do NOT stop until ≥95% confident that:
- All issues, related issues, and edge cases are covered
- All review agent findings have been addressed
- Delivered work matches the original plan completely

If below 95%, state what remains and continue working.

#### User-controlled gates
When the user has explicitly declined or deferred an action that is theirs to take — such as choosing "Leave it for you" on a merge offer, or explicitly saying they will merge manually — that action is outside the agent's scope. The 95% confidence gate applies to technical work the agent controls. Publication by merge is a user-controlled gate: once the user has deliberately declined it, the agent's work is complete and the stop condition is satisfied. Do not loop on pending user-controlled actions.

### Reviewer rejection loops

When a single file has gone through 2+ reviewer rejection cycles without
resolution, escalate to `critic_sounding_board` before the next re-dispatch.
The sounding board can identify whether the reviewer's bar is unreasonable,
the implementation is fundamentally wrong, or the rejection is structural
(e.g., skill-load failure masquerading as a content rejection). Do not
enter a third rejection cycle without sounding-board consultation.

### Skill-load failures in reviewer delegation

If a reviewer returns a REJECT that explicitly cites `SKILL_LOAD_FAILED`,
treat the verdict as **INCONCLUSIVE** — not a content rejection. Re-dispatch the
reviewer with `SKILLS: none` (omitting the problematic file reference)
so the reviewer evaluates the actual code, not the skill-loading
infrastructure. This only applies when the rejection explicitly cites
a skill-loading failure — never use `SKILLS: none` to suppress a
legitimate content-based rejection.

### Inline code fallback for restricted review contexts

When a reviewer cannot read files directly (read-restricted advisory
lanes, sandbox limitations), include the most relevant code snippets
inline in the delegation prompt with `path:line` anchors so citations
are independently verifiable. This is a **fallback only** — prefer
file-read access when available, and never inline entire files (large
inline prompts can produce malformed tool-call JSON). Keep inline
snippets to the specific functions or blocks under review.

### One-shot docs review delegation

When a reviewer rejects a documentation file, do not send piecemeal
fix-one-issue delegations. Read the entire file yourself, list ALL
issues in a single comprehensive delegation, and have the coder fix
everything in one pass. Apply this per-file — do not batch fixes
across unrelated files (scope containment still applies).
