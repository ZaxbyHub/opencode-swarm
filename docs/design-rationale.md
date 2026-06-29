# Design Rationale

## Why OpenCode Swarm Exists

Every multi-agent framework promises autonomous coding. None deliver.

The fundamental problem: **LLMs are stateless, impatient, and overconfident**. Without structure, they:
- Start coding before understanding requirements
- Lose context mid-project
- Build on broken foundations
- Produce code that "works" but fails in production

Swarm adds the discipline that LLMs lack.

---

## Core Design Decisions

### 1. Serial Execution (Not Parallel)

**The temptation**: Run agents in parallel for speed.

**The reality**: Parallel agents cause:
- Race conditions (two agents modify same file)
- Context drift (Agent A assumes X, Agent B assumes Y)
- Conflict resolution hell
- Non-reproducible results

**Swarm's approach**: One agent at a time. Always.

```
WRONG:  Agent1 ──┐
        Agent2 ──┼── Merge conflicts, inconsistencies
        Agent3 ──┘

RIGHT:  Agent1 → Agent2 → Agent3 → Consistent result
```

Slower? Yes. Working code? Also yes.

---

### 2. Phased Planning (Not Ad-Hoc)

**The temptation**: Let the LLM figure out what to do.

**The reality**: Without a plan, LLMs:
- Jump into coding without understanding scope
- Miss requirements
- Build the wrong thing confidently
- Can't estimate effort

**Swarm's approach**: Mandatory planning phase.

```markdown
## Phase 1: Foundation [3 tasks, SMALL]
## Phase 2: Core Logic [5 tasks, MEDIUM]  
## Phase 3: Integration [4 tasks, MEDIUM]
## Phase 4: Polish [3 tasks, SMALL]
```

Every task has:
- Clear description
- Acceptance criteria
- Dependencies
- Complexity estimate

The Architect can't code until the plan exists.

---

### 3. Persistent Memory (Not Session-Based)

**The temptation**: Keep everything in context window.

**The reality**: Context windows:
- Have limits
- Get compacted (losing information)
- Reset between sessions
- Can't be shared

**Swarm's approach**: `.swarm/` directory with markdown files.

```
.swarm/
├── plan.md      # What we're building, what's done
├── context.md   # Technical decisions, SME guidance
└── history/     # Archived phase summaries
```

Benefits:
- **Resumable**: Pick up any project instantly
- **Transferable**: New Architect reads files, continues work
- **Auditable**: See what was decided and why
- **Cacheable**: SME guidance doesn't need re-asking

---

### 4. QA Per Task (Not Per Project)

**The temptation**: QA at the end, ship faster.

**The reality**: End-of-project QA means:
- Bugs compound (Task 3 builds on buggy Task 2)
- Context is lost (what was Task 1 supposed to do?)
- Massive rework
- "It worked on my machine"

**Swarm's approach**: Every task goes through a multi-gate QA pipeline.

```
Task → Coder → Diff → Imports → Lint Fix → Lint Check → Secret Scan → Review → Security Review → Tests → Adversarial Tests → ✓ Complete
```

The current pipeline relies on layered quality gates before and after review:
- **Diff analysis** — Detect contract changes and trigger impact analysis if exports changed
- **Imports analysis** — Audit dependency consumers before integration issues ship
- **Lint fix + lint check** — Auto-fix first, then enforce clean diagnostics
- **Secret scan** — Detect likely credentials or key material before review
- **Security-only review** — Automatic second pass for security-sensitive files (OWASP Top 10)
- **Adversarial testing** — Attack vectors, boundary violations, injection attempts

If any gate rejects:
- Immediate feedback
- Fix while context is fresh
- Don't build on broken foundation

---

### 5. One Task at a Time (Not Batched)

**The temptation**: Send multiple tasks to Coder for efficiency.

**The reality**: Batched tasks cause:
- Context overload
- Quality degradation
- Unclear failures (which task broke?)
- Coder cuts corners

**Swarm's approach**: One task per Coder delegation.

```
WRONG:  "Implement auth, sessions, and API endpoints"
RIGHT:  "Implement login endpoint. Acceptance: Returns JWT on valid credentials."
```

Focused task = focused code.

---

### 6. Heterogeneous Models (Not Single Model)

**The temptation**: Use your best model everywhere.

**The reality**: Same model = correlated failures.
- Claude has Claude blindspots
- GPT has GPT blindspots
- If the same model writes and reviews, it misses its own mistakes

**Swarm's approach**: Different models for different roles.

```json
{
  "coder": "anthropic/claude-sonnet-4-20250514",
  "reviewer": "openai/gpt-4o",
  "critic": "google/gemini-2.0-flash"
}
```

Why this works:
- Different training data = different blindspots
- GPT catches what Claude misses
- Critic reviews the *plan*, Reviewer reviews the *code*
- Like having reviewers from different backgrounds

---

### 7. SME Caching (Not Re-Asking)

**The temptation**: Consult SMEs whenever uncertain.

**The reality**: Re-asking SMEs:
- Wastes tokens
- May get different answers
- Slows down execution
- Loses continuity

**Swarm's approach**: Cache SME guidance in context.md.

```markdown
## SME Guidance Cache

### Security (Phase 1)
- Use bcrypt with cost factor 12
- Never log tokens
- Implement rate limiting

### API (Phase 1)  
- Return 401 for auth failures
- Use RFC 7807 for errors
```

Before calling an SME, Architect checks the cache. Already answered? Skip.

---

### 8. User Checkpoints (Not Full Autonomy)

**The temptation**: Let agents run until done.

**The reality**: Full autonomy means:
- Building the wrong thing for hours
- No opportunity to course-correct
- Surprise outcomes
- Wasted resources

**Swarm's approach**: Pause at phase boundaries.

```
Phase 1 complete.
Created: user model, password hashing, migrations
Files: /src/models/user.ts, /src/auth/hash.ts

Ready to proceed to Phase 2: Core Auth?
```

User can:
- Approve and continue
- Request changes
- Adjust the plan
- Stop and resume later

---

### 9. Failure Tracking (Not Silent Retry)

**The temptation**: Just retry until it works.

**The reality**: Silent retries:
- Hide systemic problems
- Waste resources
- Never improve
- Frustrate users

**Swarm's approach**: Document all failures in plan.md.

```markdown
- [ ] Task 2.2: JWT generation
  - Attempt 1: REJECTED - Missing expiration claim
  - Attempt 2: REJECTED - Wrong signing algorithm
  - Attempt 3: ESCALATED - Architect implementing directly
```

Benefits:
- Visibility into what's hard
- Pattern detection (same failure = prompt problem)
- Accountability
- Learning opportunity

---

### 10. Explicit Dependencies (Not Implicit Order)

**The temptation**: Tasks are independent, run in any order.

**The reality**: Most tasks have dependencies:
- Can't test what isn't written
- Can't integrate what doesn't exist
- Order matters

**Swarm's approach**: Explicit dependency declaration.

```markdown
- [x] Task 2.1: Create user model
- [ ] Task 2.2: Add authentication (depends: 2.1)
- [ ] Task 2.3: Create API endpoints (depends: 2.1, 2.2)
- [ ] Task 2.4: Input validation (independent)
```

Architect respects dependencies. Won't start 2.2 until 2.1 is complete.

---

### 11. Background-First Automation (v6.7)

**The temptation:** Make automation optional via UI only.

**The reality:** Background automation enables truly autonomous workflows. Manual triggers create friction and don't scale. The danger is rushing into automation without safeguards.

**Swarm's approach:** Background automation as the default state, with explicit feature flags and default-off safety.

```json
{
  "automation": {
    "mode": "manual",  // Default: conservative, full control
    "capabilities": {
      "plan_sync": false,
      "phase_preflight": false,
      "config_doctor_on_startup": false,
      "config_doctor_autofix": false,
      "evidence_auto_summaries": false,
      "decision_drift_detection": false
    }
  }
}
```

**Why this works:**
- **Progressive rollout:** Start with `manual`, enable features as needed
- **Explicit opt-in:** Every automation feature has a feature flag (all default false)
- **Fail-safe defaults:** Nothing auto-runs unless explicitly enabled
- **User control:** Architect chooses when to enable automation
- **Reversible:** Disable mode or specific capabilities anytime

**Safety mechanisms:**
- Circuit breaker prevents cascading failures
- Loop protection stops infinite automation loops
- Event bus logs all automation events for audit trail
- Status artifact shows automation state in GUI

**Real-world benefits:**
- Config Doctor runs on startup without blocking architect
- Evidence summaries generated automatically for long-running tasks
- Plan sync happens in background, architect focuses on coding
- Drift detection catches contradictions while architect is distracted

---

### 12. Automatic Execution Triggers (v6.8)

**The temptation:** Require manual commands for every automation.

**The reality:** Even manual-triggered automation requires thinking about when to run checks. Phase boundaries and long-running tasks create natural triggers.

**Swarm's approach:** Auto-trigger automation at natural points in execution.

**Phase monitor hook:**
```typescript
// src/hooks/phase-monitor.ts
createPhaseMonitorHook() → Detects phase transitions → Triggers preflight
```

**Benefits:**
- No `/swarm preflight` needed during execution
- Consistent preflight at every phase boundary
- Automatic blocker detection before coding starts
- Reduces architect cognitive load

**Evidence summary auto-generation:**
```json
{
  "automation": {
    "capabilities": {
      "evidence_auto_summaries": true  // New default in v6.8
    }
  }
}
```

**Benefits:**
- Long-running tasks get automatic summaries
- Evidence trails preserved without manual intervention
- Context.md stays up-to-date automatically
- Better project resumability

---

### 13. Persistent Background Workers (v6.8)

**The temptation:** Run automation as ad-hoc scripts.

**The reality:** Ad-hoc scripts fail on race conditions, lose state between runs, and don't scale.

**Swarm's approach:** Background workers with file watching, debouncing, and safe shutdown.

**Plan Sync Worker:**
```typescript
// src/background/plan-sync-worker.ts
PlanSyncWorker {
  fs.watch(plan.json) + 2s polling fallback
  300ms debounce
  Overlap lock (reader/writer pattern)
  Graceful shutdown
}
```

**Benefits:**
- Auto-heals plan.json ↔ plan.md drift
- Handles network filesystems (polling fallback)
- Prevents race conditions (debounce + lock)
- Survives plugin unload (graceful shutdown)

**Integration:**
```
Plugin Init → PlanSyncWorker.register() → Background monitoring
```

**Benefits:**
- Automatic plan regeneration on change
- No manual refresh needed
- Consistent plan state across sessions
- Better human vs machine collaboration

---

### The Result (v6.8)

When you combine automatic triggers and background workers:

| v6.7 Only | v6.8 |
|-----------|------|
| Manual `/swarm preflight` at phase boundaries | Auto-trigger preflight at every phase change |
| Manual `/swarm evidence summary` for long tasks | Auto-summary for long-running tasks |
| Manual plan refresh to see latest plan.json | Background plan sync (default enabled) |
| Architect focused on coding | Architect focused on coding + automation handles sync |

**The difference:** Less manual intervention, more autonomous execution, better project maintainability.

---

### 14. Quality Gates (v6.9.0)

**The temptation:** Trust that code is ready for human review just because it passes lint and tests.

**The reality:** Human reviewers are expensive and slow. Sending them code with syntax errors, placeholder text, security vulnerabilities, or build failures wastes their time and delays the project. Reviewers should focus on architecture and edge cases, not basic quality checks.

**Swarm's approach:** Six automated gates that catch quality issues before human review.

**The six gates:**

```
Coder → syntax_check → placeholder_scan → sast_scan → sbom_generate → build_check → quality_budget → Reviewer
```

| Gate | Catches | Why Automated |
|------|---------|---------------|
| `syntax_check` | Parse errors, invalid syntax | Machine finds syntax errors instantly |
| `placeholder_scan` | TODO/FIXME comments, stubs | Prevents shipping incomplete code |
| `sast_scan` | Security vulnerabilities (65 rules across 7 languages) | Security review before human review |
| `sbom_generate` | Dependency inventory | Audit trail for compliance |
| `build_check` | Compilation errors, type failures | Build must pass before review |
| `quality_budget` | Complexity, duplication, test coverage | Maintainability enforcement |

**Why local-only:**

| Cloud/External | Local-Only |
|----------------|------------|
| Network latency | Instant feedback |
| Rate limits | Unlimited runs |
| Privacy concerns | Code never leaves machine |
| Subscription costs | Free forever |
| CI dependency | Works offline |

All v6.9.0 gates run without Docker, network, or external APIs. Optional Semgrep enhancement if already installed.

**Why before reviewer:**

```
WRONG:  Coder → Reviewer → [rejects for syntax error] → Coder fixes
        (Wastes reviewer time, delays feedback)

RIGHT:  Coder → [syntax_check FAILS] → Coder fixes → Reviewer
        (Reviewer only sees quality code)
```

**Budget enforcement rationale:**

Codebases degrade gradually. Without budgets:
- Complexity creeps up task by task
- Public API surface expands unchecked  
- Test coverage slowly declines
- Duplication accumulates

Quality budgets enforce thresholds per-task:
- `max_complexity_delta: 5` — No single task adds more than 5 complexity points
- `min_test_to_code_ratio: 0.3` — Every 10 lines of code needs 3 lines of tests
- Architect can override with explicit decision tracked in context.md

---

## The Result

When you combine all these decisions:

| Without Structure | With Swarm |
|-------------------|------------|
| Chaotic parallel execution | Predictable serial flow |
| Ad-hoc "figure it out" | Documented phased plan |
| Lost context between sessions | Persistent `.swarm/` memory |
| QA as afterthought | QA per task |
| Batched, unfocused work | One task at a time |
| Single model blindspots | Heterogeneous review |
---

### 15. Hard Blocks Replace Soft Warnings (v6.21)

**The temptation:** Advisory warnings are kinder to the architect; it can choose to act on them.

**The reality:** Soft warnings accumulate. A model mid-session will suppress or ignore prior warnings as context compresses. Repeated soft warnings are noise; the architect learns to expect them and continues the violation.

**Swarm's approach:** Escalate to hard blocks at an explicit threshold.

| Behavior | Before v6.21 | v6.21 |
|----------|-------------|-------|
| Architect writes files directly | Warning for every write | Warning for writes 1–2; Error thrown at write ≥ 3 (`SELF_CODING_BLOCK`) |
| Task completion without review | Always accepted | Rejected unless state machine is in `tests_run` or `complete` |
| QA skip count | Reset on first gate agent | Reset only when BOTH reviewer AND test_engineer seen |

**Why Error and not return value?** An `Error` with `SELF_CODING_BLOCK` in the message propagates through every layer that might silently discard a structured return value. It surfaces in logs, in tool output, and in the LLM's context — it cannot be ignored.

---

### 16. Per-Task State Machine (v6.21)

**The temptation:** Track task progress informally — the plan.md `[x]` checkbox is enough.

**The reality:** `[x]` in plan.md is a string edit, not a verified state transition. An architect in a hurry can mark a task complete without gates having run. Nothing stops this.

**Swarm's approach:** A runtime state machine with forward-only transitions enforced in code.

```
idle → coder_delegated → pre_check_passed → reviewer_run → tests_run → complete
```

`update_task_status` refuses `status='completed'` unless the task is in `tests_run` state. The state machine is session-local — it cannot be written from the plan file or manipulated by prompt. An illegal transition attempt throws `INVALID_TASK_STATE_TRANSITION` and stops execution.

**Why forward-only?** Backward transitions indicate a bug in the workflow, not a legitimate retry. If tests fail, the task returns to `coder_delegated` by starting a new coder delegation (resetting the task state naturally) — not by walking back the state machine.

---

### 17. Structural Scope Declaration (v6.21)

**The temptation:** Trust that the coder will only modify the files named in the task spec.

**The reality:** Models under long context sometimes modify adjacent files "helpfully." Without enforcement, these unintended edits bypass the task's QA gate — the reviewer evaluated the declared scope, not the extra files.

**Swarm's approach:** Runtime scope tracking with violation detection.

The FILE: directive in a coder delegation is extracted at runtime and stored as the declared coder scope. After the coder task completes, the actual modified files are compared against the declared scope. More than 2 out-of-scope files triggers a warning in the next architect turn.

The `declare_scope` tool lets the architect pre-declare scope before composing a delegation, providing an explicit alternative to automatic FILE: extraction.

**Why a warning and not a hard block?** The coder may legitimately modify a shared utility file not listed in FILE: (e.g., adding an export). A hard block at any out-of-scope write would be too strict. Two files of tolerance handles the common legitimate case while catching broad scope drift.

**Why 2 files?** Empirical: legitimate adjacent edits (adding an export, fixing a type) rarely exceed 2 files. Three or more undeclared files almost always indicates scope creep or a misunderstood task boundary.

---

### 18. Tier-Based Behavioral Prompt Trimming (v6.21)

**The temptation:** Give every model the same full architect prompt.

**The reality:** Verbose behavioral guidance consumes context on models that are already at or near their window limit. Smaller models struggle to follow long instructions; they benefit from shorter, more directive prompts.

**Swarm's approach:** Structural markers in the architect prompt allow sections to be stripped for low-capability models.

`<!-- BEHAVIORAL_GUIDANCE_START --> … <!-- BEHAVIORAL_GUIDANCE_END -->` pairs wrap three verbose sections. When `isLowCapabilityModel(session.activeModel)` returns `true`, these sections are replaced with `[Enforcement: programmatic gates active]`.

**Why is this safe?** The replaced sections describe behavior that is already enforced programmatically: the state machine (Phase 2), the hard blocks (Phase 1), and the scope containment (Phase 5). The prompt text and the code enforcement duplicate the same rules. On capable models, both layers reinforce each other. On smaller models, the code layer alone is sufficient — the prompt overhead is eliminated.

---

## The Result (Updated)

| Without Structure | With Swarm |
|-------------------|------------|
| Chaotic parallel execution | Predictable serial flow |
| Ad-hoc "figure it out" | Documented phased plan |
| Lost context between sessions | Persistent `.swarm/` memory |
| QA as afterthought | QA per task |
| Batched, unfocused work | One task at a time |
| Single model blindspots | Heterogeneous review |
| Repeated SME questions | Cached guidance |
| Full autonomy disasters | User checkpoints |
| Silent failures | Documented attempts |
| Implicit ordering | Explicit dependencies |
| Manual-only workflow | **Background-first automation** (v6.7) |
| Pre-reviewer lint only | **Six quality gates** before human review (v6.9.0) |
| Cloud-based security scanning | **Local-only** SAST and SBOM generation (v6.9.0) |
| Soft advisory warnings | **Hard blocks** with error propagation (v6.21) |
| Plan checkbox as state | **Runtime state machine** with forward-only transitions (v6.21) |
| Coder scope on trust | **Structural scope declaration** with violation detection (v6.21) |
| Same prompt for all models | **Tier-based prompt trimming** for capability-matched context (v6.21) |

**The difference:** Code that actually works. And gets done efficiently.
