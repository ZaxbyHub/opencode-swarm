# Knowledge Lifecycle & Skills System

This document describes the complete lifecycle of knowledge in OpenCode Swarm: from creation through retrieval, feedback, promotion, and compilation into reusable skills. For knowledge storage schema and configuration details, see [Knowledge System](knowledge.md).

## Complete Knowledge Lifecycle

### Phase 1: Knowledge Creation

Knowledge enters the system through four routes:

| Route | Source | Command | Tier | Scope |
|-------|--------|---------|------|-------|
| **Agent tool** | Active agent (coder, reviewer, test, SME, docs) during a phase | `knowledge_add` | Swarm | Project-specific |
| **Manual promotion** | Human contributor | `/swarm promote "<lesson>"` | Hive | Cross-project |
| **Curator recommendation** | Curator agent after phase analysis | Auto-generated via curator insights | Swarm/Hive | Project-specific or evergreen |
| **Legacy migration** | v6 projects | `/swarm knowledge migrate` | Swarm | One-time import |

Each entry carries:
- **`lesson`** — the knowledge claim (15–280 chars, validated for safety)
- **`category`** — `pattern`, `lesson`, `decision`, `domain`, `todo`
- **`confidence`** — 0.0–1.0, reflecting certainty
- **`tier`** — `swarm` (project) or `hive` (cross-project)
- **Optional v2 directives** — `triggers`, `required_actions`, `forbidden_actions`, `applies_to_agents`, `applies_to_tools`, `directive_priority`, source references

Storage: `.swarm/knowledge.jsonl` (swarm) or `~/.local/share/opencode-swarm/shared-learnings.jsonl` (hive, platform-specific).

### Phase 2: Knowledge Injection & Application

During phase execution, knowledge is **retrieved and injected** into the architect's context:

1. **Search & Rank**
   - Unified `searchKnowledge()` queries both swarm and hive
   - Near-duplicate removal via Jaccard bigram similarity (threshold 0.6)
    - Action-aware ranking: triggers, `applies_to_agents/tools`, priority level, trigger phrase boost
    - For ranking algorithm details, see [Knowledge System](knowledge.md#query-and-injection).

2. **Injection Budget** (context-adaptive)
   - \>60% headroom: full budget (up to 5 entries, 2000 chars)
   - 20–60% headroom: half budget
   - 5–20% headroom: quarter budget
   - \<5%: skipped

3. **Architect Application Contract** (v2)
   - Architect receives structured `<swarm_knowledge_directives>` block
   - For each applicable directive, architect **MUST** emit one of:
     - `KNOWLEDGE_APPLIED: <id>` — observed in next action
     - `KNOWLEDGE_IGNORED: <id> reason=...` — not applicable this turn
     - `KNOWLEDGE_VIOLATED: <id> reason=...` — runtime evidence shows breach

   Example:
   ```
   <swarm_knowledge_directives>
   - id: lesson-abc123
     confidence: 0.94
     priority: critical
     trigger: coder delegation modifying source files
     required: call declare_scope before coder delegation
     forbidden: bash/eval/heredoc file writes
     skill: file:.opencode/skills/generated/scope-discipline/SKILL.md
     verification: reviewer must reject scope bypass
   </swarm_knowledge_directives>
   ```

4. **Outcomes Recorded**
   - Chat-visible `KNOWLEDGE_*` markers are the enforcement gate
   - `knowledge_receipt` tool records outcomes to `.swarm/knowledge-application.jsonl`
    - Counters: `shown_count`, `acknowledged_count`, `applied_explicit_count`, `ignored_count`, `violated_count`, `succeeded_after_shown_count`, `failed_after_shown_count`
    - See [Knowledge System](knowledge.md#retrieval-outcome-counters) for the counter schema.

### Phase 3: Feedback & Learning

After phase completion, feedback is collected:

1. **Outcome Scoring**
   - Entries with **positive outcome signal** (`applied_explicit_count >= 3` OR `succeeded_after_shown_count >= 3`) → candidate for skill generation
   - **Negative outcome signal** (`violated_count` + `failed_after_shown_count > threshold`) → blocked from promotion
   - **Evergreen threshold**: `confidence >= 0.9` AND `utility_score >= 0.8`
   - **Low-utility flag**: `utility_score <= 0.3` after `>= 3` retrievals AND `shown_count >= 5`

2. **Knowledge Durability**
   - **TTL decay**: Active entries age every successful phase (increments `phases_alive`)
    - Archived when `phases_alive > max_phases` (default 10 phases for general, 3 for `todo`)
    - Archived entries are excluded from query results but preserved on disk (not deleted). They can be manually restored via `/swarm knowledge restore` if needed. Note that TTL-archived entries are in a distinct state from quarantined entries.
   - **Promoted entries are TTL-exempt** — live until explicitly quarantined
   - Quarantine workflow: `/swarm knowledge quarantine <id> [reason]` hides but preserves

3. **Curator Review** (optional, if enabled)
   - Curator agent reviews phase outcomes, detects repeated violations, missing guidance
   - Emits optional `skill_candidates` JSON block (high-confidence directives for skill compilation)
   - Triggers hive promotion check via `checkHivePromotions()`

### Phase 4: Promotion to Hive (Cross-Project)

Swarm entries can be promoted to hive knowledge via three routes:

| Route | Trigger | Speed |
|-------|---------|-------|
| **Explicit** | `hive_eligible=true` AND ≥3 distinct phase confirmations | Manual or curator |
| **Fast-track** | Entry tagged `hive-fast-track` | Immediate (bypasses phase count) |
| **Age-based** | Entry age ≥ `auto_promote_days` (default 90 days) | Automatic on next curator run |

Manual promotion: `/swarm promote --from-swarm <id>`

Promoted hive entries gain cross-project weight: `encounter_score` weighted by `same_project_weight` (1.0, same project) vs `cross_project_weight` (0.5, other projects).

### Phase 5: Skill Generation & Compilation

Mature, high-confidence knowledge can be compiled into reusable **SKILL.md** files.

#### Maturity Gate

An entry passes the maturity gate if:

1. **Not negatively evidenced** — `computeOutcomeSignal >= 0` (no strong negative outcome)
 2. **Strong outcome bypass** — (`applied_explicit_count >= 3` OR `succeeded_after_shown_count >= 3`) AND `computeOutcomeSignal > 0`
   - Bypasses confidence floor and confirmation count
   - Allows well-evidenced singletons to become skills early
3. **Legacy AND gates** — for other entries:
   - Confidence >= `min_skill_confidence` (default 0.70)
   - Either `confirmed_by` count >= `min_skill_confirmations` (default 2 distinct phases) OR strong outcome record
    - Both conditions must independently hold (neither alone is sufficient)

> **Note:** `confirmed_by` tracks distinct phase numbers where the entry was actually applied (recorded via `KNOWLEDGE_APPLIED` markers). Only phases with evidence of use count toward the threshold.

#### Generation Workflow

```
Agent task / curator review
  ↓
  skill_generate (creates draft)
  ↓
  .swarm/skills/proposals/<slug>.md
  ↓
  [optional] skill evaluation + validation
  ↓
  Human review via skill_inspect / skill_list
  ↓
  skill_apply (promotes to active)
  ↓
  .opencode/skills/generated/<slug>/SKILL.md
```

1. **Candidate Compilation** — `skill_generate` reads source knowledge entries, creates **draft** at `.swarm/skills/proposals/<slug>.md`
   - Frontmatter includes `triggers:` phrases from source knowledge
   - Includes generator marker: `<!-- generated by opencode-swarm skill-generator -->`

2. **Optional Validation** — If eval fixtures exist at `.swarm/skills/evals/<slug>/*.json`, candidate is checked:
   ```json
   {
     "required_phrases": ["call declare_scope"],
     "forbidden_phrases": ["skip scope declaration"]
   }
   ```
   - Missing evals fail open and report `unevaluated`
   - Existing active skills must strictly improve incumbent

3. **Human Review** — Human inspects draft via:
   - `skill_list` — list all drafts and active skills
   - `skill_inspect <slug>` — print skill with source knowledge IDs
   - Edit draft if needed (preserved on skill_apply unless it diverges too much)

4. **Activation** — `skill_apply <slug>` promotes draft to `.opencode/skills/generated/<slug>/SKILL.md`
   - Becomes available to all agents via `SKILLS:` delegation field
   - Locked against overwrite (requires `force=true` if generator marker removed)
    - Rejected candidates recorded to `.swarm/skills/rejected-edits.jsonl`
    - Entries are added to this file by `appendRejectedSkillEdit` when skill evaluation fails (e.g., required-phrases or forbidden-phrases checks). `isRejectedSkillContent` reads this file later to detect hash matches with previously rejected content.

5. **Ongoing Refinement** — `skill_regenerate <slug>` rebuilds active skill from updated source knowledge

#### Skill File Layout

```
.swarm/skills/proposals/<slug>.md              # drafts (awaiting review)
.swarm/skills/evals/<slug>/*.json              # validation fixtures
.swarm/skills/rejected-edits.jsonl             # audit buffer
.opencode/skills/generated/<slug>/SKILL.md     # active generated skills
```

#### Frontmatter Example

Generated skills inherit trigger phrases and metadata from source knowledge:

```yaml
---
name: declare-scope-before-delegation
description: Enforce scope declaration before coder/reviewer delegation
triggers:
  - coder delegation
  - scope declaration
  - declare_scope
applies_to_agents:
  - coder
  - reviewer
applies_to_tools:
  - task
  - Task
directive_priority: high
---

# Declare Scope Before Delegation

When delegating to coder or reviewer, first call `declare_scope` to...
```

---

## Generated Skills: Deep Dive

Generated skills turn mature knowledge entries into reviewable SKILL.md files that agents load through the normal skill system.

### Lifecycle Summary (Short Form)

1. Knowledge starts as swarm or hive entries in the knowledge store
2. Event-sourced feedback records outcomes (shown, acknowledged, applied, ignored, violated, or succeeded)
3. `skill_generate` and `skill_improve` select candidates using maturity gate (confirmations + outcome rollups)
4. Drafts are written under `.swarm/skills/proposals/`
5. `skill_apply` promotes a reviewed draft to `.opencode/skills/generated/<slug>/SKILL.md`
6. Scheduled consolidation never activates generated skills automatically — human or architect must review

### Skill Improver Agent

The optional `skill_improver` agent (issue #629) runs rare, high-capability reviews:

```jsonc
"skill_improver": {
  "enabled": false,
  "max_calls_per_day": 10,
  "trigger": "manual",              // 'manual' (default) | 'automatic'
  "consolidation_interval_hours": 24,
  "write_mode": "proposal",         // 'proposal' (no mutation) | 'draft_skills'
  "targets": ["skills", "spec", "architect_prompt", "knowledge"],
  "require_user_approval": true,
  "quota_window": "utc"
}
```

When invoked, emits proposal with sections: Inventory snapshot, Repeated ignored/violated directives, Concrete recommendations, Cluster suggestions, Risks.

### Curator Integration

When `curator.skill_generation_enabled: true` (default), the curator can emit `skill_candidates` JSON blocks:

- High-confidence candidates (>= `curator.min_skill_confidence`, default 0.70) trigger `skill_generate` in **draft** mode
- When `skill_generation_mode: "draft"` (default), activation always requires human review via `skill_apply`. When `"active"`, generated skills are placed directly into `.opencode/skills/generated/` without a draft step.
- Curator diagnostics (debug-gated) report malformed JSON without writes

---

## Tools & Commands

### Skills Management

| Tool | Purpose | Mode |
|------|---------|------|
| `skill_generate` | Compile knowledge into draft (`.swarm/`) or active (`.opencode/`) skill | Architect → curator |
| `skill_list` | List drafts and active generated skills | Any agent |
| `skill_apply` | Activate a draft into `.opencode/skills/generated/<slug>/SKILL.md` | Human (manual command) |
| `skill_inspect` | Print skill body with source knowledge IDs | Any agent |
| `skill_regenerate` | Rebuild active skill from updated source knowledge | Human or curator |
| `skill_improve` | (Optional) Invoke skill_improver agent for capability review | Architect with curator enabled |

### Knowledge Commands (See [Commands Reference](commands.md) for full detail)

| Command | Purpose |
|---------|---------|
| `/swarm knowledge` | List active entries |
| `/swarm knowledge migrate` | Import legacy `.swarm/context.md` |
| `/swarm knowledge quarantine <id> [reason]` | Hide entry (preserved) |
| `/swarm knowledge restore <id>` | Un-quarantine |
| `/swarm promote <text>` | Create new hive entry |
| `/swarm promote --from-swarm <id>` | Promote existing swarm entry |
| `/swarm curate` | Run curator review + hive promotion pass |
| `/swarm learning [--json]` | Show aggregate metrics and ROI |

---

## Configuration

Key settings (full reference: `src/config/schema.ts`):

```jsonc
{
  "knowledge": {
    "enabled": true,
    "swarm_max_entries": 100,
    "hive_max_entries": 200,
    "auto_promote_days": 90,
    "default_max_phases": 10,
    "todo_max_phases": 3
  },
  "knowledge_application": {
    "enabled": true,
    "mode": "warn",                    // 'warn' (default) | 'enforce'
    "min_confidence": 0.85,
    "critical_requires_ack": true,
    "high_risk_tools": ["save_plan", "update_task_status", "phase_complete"]
  },
  "curator": {
    "skill_generation_mode": "draft",        // 'draft' (default) | 'active': 'active' bypasses draft review
    "skill_generation_enabled": true,
    "min_skill_confidence": 0.70,
    "min_skill_confirmations": 2
  }
}
```

---

## Review Checklist for Generated Skills

When reviewing a draft skill before applying:

- [ ] Confirm the source knowledge IDs still match the intended behavior
- [ ] Check that required and forbidden actions are concrete enough for an agent to follow
- [ ] Remove stale project-specific references before applying a cross-project skill
- [ ] Prefer a narrow skill over broad procedural advice when only one workflow is supported by evidence
- [ ] Verify frontmatter `triggers:` and `applies_to_*` fields are specific (no generic tokens)
- [ ] Ensure examples use realistic scenarios agents will encounter

---

## Related Documentation

- **[Knowledge System](knowledge.md)** — storage schema, TTL decay, curation, validation, query ranking
- **[Commands Reference](commands.md)** — `/swarm` subcommands including knowledge, skill, curator commands
- **[Configuration Reference](configuration.md)** — all knowledge.*, knowledge_application.*, curator.* schema keys
- **[Evidence and Telemetry](evidence-and-telemetry.md)** — how retrieval outcomes feed learning signals
- **[Writing Tests Skill](../.opencode/skills/writing-tests/SKILL.md)** — test rules for skill changes
- **[Architecture Deep Dive](architecture.md)** — knowledge in the control loop, evidence schema

---

## Glossary

| Term | Definition |
|------|-----------|
| **Swarm knowledge** | Project-specific, session-local entries in `.swarm/knowledge.jsonl` |
| **Hive knowledge** | Cross-project, persistent entries in platform-specific user data directory |
| **Generated skill** | Compilable SKILL.md derived from mature knowledge (review checklist, triggers, directives) |
| **Maturity gate** | Decision logic determining if an entry can become a skill (outcome signal, confidence, confirmations) |
| **Outcome signal** | Rollup of `applied_explicit_count`, `succeeded_after_shown_count`, `violated_count`, etc. |
| **Knowledge injection** | Retrieval of relevant entries and inclusion in architect's prompt at phase start — see [knowledge.md#query-and-injection](knowledge.md#query-and-injection) |
| **Promotion** | Swarm → Hive transition after threshold (3 phases confirmed, fast-track, or 90-day age) |
| **v2 directives** | Optional fields on knowledge entries (`triggers`, `required_actions`, `applies_to_agents/tools`, priority) |
| **Knowledge application contract** | Architect MUST emit `KNOWLEDGE_APPLIED/IGNORED/VIOLATED` for applicable directives |
