# Knowledge System

Swarm tracks two kinds of knowledge:

- **Swarm knowledge** — project-specific lessons learned during a session. Lives in `.swarm/knowledge.jsonl`.
- **Hive knowledge** — evergreen lessons that have been confirmed across projects. Lives in your user data directory.

When an architect receives a new message, entries from both stores are merged and deduplicated before injection.

> **v2 actionable directives.** Knowledge entries can carry optional fields
> (`triggers`, `required_actions`, `forbidden_actions`, `applies_to_tools`,
> `applies_to_agents`, `directive_priority`, `generated_skill_path`). The
> Architect receives these as a structured `<swarm_knowledge_directives>`
> block and must acknowledge each applicable directive (`KNOWLEDGE_APPLIED`)
> or explicitly skip it (`KNOWLEDGE_IGNORED reason=...`). See [Actionable
> directives](#actionable-directives-v2) and
> [Knowledge application contract](#knowledge-application-contract-v2) below.

---

## Storage Locations

### Swarm (per-project)

```
.swarm/knowledge.jsonl            # active entries
.swarm/knowledge-rejected.jsonl   # entries that failed validation
```

### Hive (cross-project)

Resolved platform-specifically:

| Platform | Path |
|----------|------|
| Linux | `$XDG_DATA_HOME/opencode-swarm/shared-learnings.jsonl` (default `~/.local/share/opencode-swarm/`) |
| macOS | `~/Library/Application Support/opencode-swarm/shared-learnings.jsonl` |
| Windows | `%LOCALAPPDATA%\opencode-swarm\Data\shared-learnings.jsonl` |

Rejected hive lessons: `shared-learnings-rejected.jsonl` next to the main file.

---

## Entry Schema

Every entry is a JSON line with these fields (see `src/hooks/knowledge-types.ts`):

```json
{
  "id": "lesson-abc123",
  "tier": "swarm",
  "lesson": "Prefer stream.Readable.from(generator) over async iterators for backpressure.",
  "category": "pattern",
  "tags": ["node", "streams"],
  "scope": "global",
  "confidence": 0.9,
  "status": "active",
  "confirmed_by": ["..."],
  "retrieval_outcomes": [],
  "phases_alive": 0,
  "max_phases": 10
}
```

Swarm entries add `project_name` and a `PhaseConfirmationRecord[]`. Hive entries add `source_project` and `encounter_score`.

---

## Lifecycle

### Creation

Entries can be created four ways:

1. **Agents write via `knowledge_add` tool** — normal flow during a phase.
2. **Manual: `/swarm promote "<lesson>"`** — write directly to hive.
3. **Curator recommends** — LLM-driven promotions from the curator agent.
4. **Migration: `/swarm knowledge migrate`** — one-time import from legacy `.swarm/context.md`.

### Reinforcement

Near-duplicate lessons are not discarded when they match an active swarm entry.
The curator and `knowledge_add` reinforce the existing entry by appending one
`confirmed_by` record for the current phase when that phase is not already
present. Same-phase repeats are idempotent no-ops. A real new phase
confirmation refreshes `updated_at`, resets `phases_alive` to `0`, and
recomputes confidence from the distinct phase-confirmation count.

### Promotion (swarm → hive)

Three routes in `checkHivePromotions()`:

| Route | Trigger |
|-------|---------|
| Explicit | `hive_eligible=true` AND ≥3 distinct phases confirmed |
| Fast-track | Entry tagged `hive-fast-track` (bypasses phase count) |
| Age-based | Entry age ≥ `auto_promote_days` (default 90) |

Manual: `/swarm promote --from-swarm <id>`.

### Quarantine / Restore

Quarantined entries are hidden from queries but preserved:

```bash
/swarm knowledge quarantine lesson-abc123 "false positive"
/swarm knowledge restore lesson-abc123
```

Quarantined, archived, and `quarantined_unactionable` entries are inactive for
query injection, hive promotion, and hive encounter-score reinforcement. New
near-duplicate evidence reinforces only active entries; inactive duplicates stay
archived/quarantined and a fresh candidate can be created instead.

### Expiration (N-phase TTL decay)

At every successful phase completion, `sweepAgedEntries()` runs:

1. Increments `phases_alive` on all active entries.
2. Archives entries whose `phases_alive > max_phases`.
3. TTLs: `default_max_phases` (10) for most, `todo_max_phases` (3) for `todo`-category entries.
4. **Promoted entries are TTL-exempt** — they live until explicitly quarantined.

TODO entries are *removed*, not archived, after their TTL.

---

## Query and Injection

Knowledge is injected into the architect's prompt at phase start via `createKnowledgeInjectorHook()`. The reader merges swarm + hive with near-duplicate removal (Jaccard bigram similarity).

**Injection budget** adapts to available context:

| Context headroom | Regime |
|------------------|--------|
| >60% | Full budget — up to `max_inject_count` entries, `inject_char_budget` chars |
| 20–60% | Half — half the entries, half the chars |
| 5–20% | Quarter — minimal injection |
| <5% | Skipped |

Defaults:

- `max_inject_count`: 5 entries
- `inject_char_budget`: 2000 chars total
- `max_lesson_display_chars`: 120 chars per lesson (truncation only; stored text unchanged)
- `dedup_threshold`: 0.6

---

## Configuration

All keys live under `knowledge.*` in your config (see `src/config/schema.ts:804`):

| Key | Type | Default | Purpose |
|-----|------|:---:|---------|
| `enabled` | bool | `true` | Master switch |
| `swarm_max_entries` | int | 100 | FIFO cap per project |
| `hive_max_entries` | int | 200 | FIFO cap cross-project |
| `auto_promote_days` | int | 90 | Age threshold for auto-promotion |
| `max_inject_count` | int | 5 | Max entries per injection |
| `inject_char_budget` | int | 2000 | Total injection block size |
| `max_lesson_display_chars` | int | 120 | Per-lesson truncation |
| `dedup_threshold` | float | 0.6 | Near-duplicate detection |
| `scope_filter` | array | `["global"]` | Scope tags to include |
| `hive_enabled` | bool | `true` | Read/write hive knowledge |
| `validation_enabled` | bool | `true` | Run 3-layer validator |
| `evergreen_confidence` | float | 0.9 | Confidence threshold for evergreen |
| `evergreen_utility` | float | 0.8 | Utility score for evergreen |
| `low_utility_threshold` | float | 0.3 | Flag for removal at or below |
| `min_retrievals_for_utility` | int | 3 | Retrievals before utility scoring |
| `default_max_phases` | int | 10 | General TTL |
| `todo_max_phases` | int | 3 | TODO-category TTL |
| `same_project_weight` | float | 1.0 | Encounter score (source project) |
| `cross_project_weight` | float | 0.5 | Encounter score (other projects) |
| `enrichment.max_calls_per_day` | int | 30 | Dedicated daily quota for curator/close-time/unactionable-hardening LLM enrichment of plain prose into actionable directives |
| `enrichment.quota_window` | `"utc"`/`"local"` | `"utc"` | Calendar window for the enrichment quota |

---

## Migration

`/swarm knowledge migrate` imports from legacy `.swarm/context.md` into `.swarm/knowledge.jsonl`. Idempotent — a sentinel file `.swarm/.knowledge-migrated` prevents re-runs.

Legacy sections mapped into the new schema:

- `lessons-learned` → category `lesson`
- `patterns` → category `pattern`
- `sme-cache` → category `domain`
- `decisions` → category `decision`

Entries that fail schema validation are dropped. Near-duplicates are collapsed via the dedup threshold.

---

## Validation

Three layers enforce quality. An entry must pass all three or it lands in `-rejected.jsonl`:

1. **Structural** — length 15–280 chars, valid category, scope, confidence in [0,1].
2. **Content safety** — rejects dangerous commands (`rm -rf`, `mkfs`, `chmod 777`, `eval`, etc.) even in lesson text.
3. **Semantic** — flags vague lessons (no technical reference + no action verb) and contradictions with existing entries.

---

## Quality Signals

### Evergreen

Entries with `confidence ≥ 0.9` AND `utility_score ≥ 0.8` are marked evergreen. They survive curation sweeps without review.

### Low-utility

Calculated after `min_retrievals_for_utility` retrievals (default 3). Entries at or below `low_utility_threshold` (default 0.3) with `shown_count ≥ 5` are flagged for removal. (Pre-v2 entries used `applied_count` as the dominant signal; the v1→v2 normalizer copies the legacy field into `shown_count` on read so historical entries continue to trip this audit correctly. New code must read `shown_count` for "saw it" and `applied_explicit_count` for "applied it".)

### Encounter score (hive-only)

Hive entries track an `encounter_score` weighted by project:

- Same project encounter: × `same_project_weight` (default 1.0)
- Cross-project encounter: × `cross_project_weight` (default 0.5)

This prevents one noisy project from dominating hive promotions.

---

## Commands

| Command | Purpose |
|---------|---------|
| `/swarm knowledge` | List active entries |
| `/swarm knowledge migrate` | Import legacy `.swarm/context.md` |
| `/swarm knowledge quarantine <id> [reason]` | Hide entry from queries |
| `/swarm knowledge restore <id>` | Un-quarantine an entry |
| `/swarm promote <text>` | Write new hive entry |
| `/swarm promote --from-swarm <id>` | Promote existing swarm entry |
| `/swarm curate` | Run curator review and hive promotion pass |

See [Commands Reference](commands.md) for full flag details.

---

## Related

- [Architecture Deep Dive](architecture.md) — knowledge in the control loop
- [Evidence and Telemetry](evidence-and-telemetry.md) — how retrieval outcomes feed utility scoring
- [Configuration Reference](configuration.md) — full `knowledge.*` schema

---

## Actionable directives (v2)

A v2 entry can carry optional metadata that turns a passive lesson into an
actionable directive. All fields are optional and v1 entries continue to read
without migration.

| Field | Type | Purpose |
|-------|------|---------|
| `triggers` | `string[]` | Phrases that surface the directive when the current task / tool / agent context matches. |
| `required_actions` | `string[]` | What the architect / subagent MUST do when the trigger fires. |
| `forbidden_actions` | `string[]` | What the directive forbids. |
| `applies_to_agents` | `string[]` | Agent role names (snake_case) the directive applies to. |
| `applies_to_tools` | `string[]` | Tool names the directive applies to. |
| `verification_checks` | `string[]` | Reviewer / test_engineer / runtime checks. |
| `directive_priority` | `"low"\|"medium"\|"high"\|"critical"` | Ranking + enforcement weight. |
| `source_refs` | `string[]` | Pointers (file:line, plan section). Sanitized; no path traversal. |
| `source_knowledge_ids` | `string[]` | UUIDs of source entries (for derived/clustered entries). |
| `generated_skill_slug` | `string` | Slug of compiled SKILL.md. |
| `generated_skill_path` | `string` | Repo-local path to compiled SKILL.md. Must live under `.opencode/skills/generated/` or `.swarm/skills/proposals/`. |
| `last_applied_at` | ISO 8601 | Updated by `recordAcknowledgment("applied")`. |
| `last_acknowledged_at` | ISO 8601 | Updated by any explicit ack. |

Retrieval-outcome counters now distinguish:

- `shown_count` — included in an injection block.
- `acknowledged_count` — any explicit ack received.
- `applied_explicit_count` — explicit `KNOWLEDGE_APPLIED`.
- `ignored_count` — explicit `KNOWLEDGE_IGNORED`.
- `violated_count` — explicit `KNOWLEDGE_VIOLATED` (or runtime-inferred).
- `succeeded_after_shown_count` — phase succeeded after this entry was shown.
- `failed_after_shown_count` — phase failed after this entry was shown.

**Frozen legacy fields** (kept on disk for backward compatibility, never
auto-incremented in v2):

- `applied_count` — pre-v2 it was bumped on every "shown" event. The v1→v2
  normalizer copies the historical value into `shown_count` on read.
- `succeeded_after_count` / `failed_after_count` — replaced by
  `succeeded_after_shown_count` / `failed_after_shown_count`.

If you have analytics or downstream tooling that reads `applied_count`,
migrate it to `shown_count` (for "shown") or `applied_explicit_count` (for
"actually applied"). The frozen fields still exist on disk; they will not
change after this release.

---

## Action-aware retrieval

The injector now uses
`searchKnowledge({ directory, config, context: ctx, mode: 'auto_injection', agent: 'architect' })`
where `ctx` carries the current phase, task id, tool/action name, target agent,
file paths, recent reviewer/test failures, declared scope, and a `mode` value
(`phase_start`, `delegation`, `tool_before`, `phase_complete`, `manual_recall`,
`curator`). The unified `searchKnowledge` service supersedes the earlier
`readContextualKnowledge` helper and is also used by `knowledge_recall`.

Ranking rules:

- A `directive_priority: "critical"` entry whose trigger / tool / agent matches
  the context is **forced into the top-N within budget**.
- An entry whose `confidence >= directive_min_confidence` and whose
  `applies_to_tools` / `applies_to_agents` matches the current action gets a
  strong rank boost.
- Entries with an active `generated_skill_path` are preferred over raw lesson
  repetition.
- Archived entries are excluded (also enforced by `knowledge_recall`).

Cache key: phase + tool + action + targetAgent + taskId + filePaths hash. The
phase-only cache from v1 has been retired.

---

## Knowledge application contract (v2)

The Architect now receives a structured directive block:

```
<swarm_knowledge_directives>
- id: <uuid>
  confidence: 0.94
  priority: critical
  trigger: coder delegation modifying source files
  required: call declare_scope before coder delegation
  forbidden: bash/eval/heredoc file writes
  skill: file:.opencode/skills/generated/scope-discipline/SKILL.md
  verification: reviewer must reject scope bypass
</swarm_knowledge_directives>
```

The Architect prompt requires inspecting this block before:

1. Producing or saving a plan (`save_plan`).
2. Updating a task status (`update_task_status`).
3. Delegating to coder, reviewer, test_engineer, sme, docs, or designer.
4. Calling `phase_complete`.
5. Escalating or invoking `skill_improve`.

For each applicable directive, the Architect emits:

- `KNOWLEDGE_APPLIED: <id>` — directive observed in the next compliant action.
- `KNOWLEDGE_IGNORED: <id> reason=<short>` — does not apply this turn.
- `KNOWLEDGE_VIOLATED: <id> reason=<short>` — runtime evidence shows it was breached.

Chat-text markers (KNOWLEDGE_APPLIED/IGNORED/VIOLATED) are the sole mechanism that
satisfies the knowledge-application enforcement gate. The `knowledge_receipt` tool
(which replaced the former `knowledge_ack`) records knowledge-usage receipts for
audit — including applied/ignored/contradicted outcomes and new-lesson persistence
— but does NOT satisfy the enforcement gate.

### Audit log

Every outcome is appended as a JSONL line to:

```
.swarm/knowledge-application.jsonl
```

with `{timestamp, phase, taskId, action, tool, targetAgent, knowledgeId,
result: "shown"|"acknowledged"|"applied"|"ignored"|"violated", reason,
generatedSkillPath, sessionId}`.

### Enforcement modes

```jsonc
"knowledge_application": {
  "enabled": true,
  "mode": "warn",            // 'warn' (default) advises; 'enforce' blocks
  "min_confidence": 0.85,
  "critical_requires_ack": true,
  "require_skill_refs": true,
  "high_risk_tools": ["save_plan", "update_task_status", "phase_complete", "task", "Task"]
}
```

In `enforce` mode the gate (`gateKnowledgeApplication` in
`src/hooks/knowledge-application.ts`) blocks high-risk actions when a critical
directive was shown but received no acknowledgment.

**`high_risk_tools`** — optionally override the set of tools that trigger the
acknowledgment gate. When absent, defaults to `["save_plan",
"update_task_status", "phase_complete", "task", "Task"]`. Narrow the list to
reduce noise; expand it to cover additional tools that should require knowledge
directive acknowledgment before executing.

---

## Generated skills (knowledge-to-skill compiler)

Mature, repeated, high-confidence knowledge can be compiled into a SKILL.md
that subagents load via the existing `SKILLS:` delegation field.

### Tools

| Tool | Purpose |
|------|---------|
| `skill_generate` | Compile candidates into draft (`.swarm/skills/proposals/<slug>.md`) or active (`.opencode/skills/generated/<slug>/SKILL.md`) skills. |
| `skill_list` | List drafts and active generated skills. |
| `skill_apply` | Activate a draft into `.opencode/skills/generated/<slug>/SKILL.md`. |
| `skill_inspect` | Print a skill body with source knowledge IDs. |
| `skill_regenerate` | Rebuild an active generated skill from current source knowledge. |

### Layout

```
.swarm/skills/proposals/<slug>.md           # drafts (curator + skill_improver)
.swarm/skills/evals/<slug>/*.json           # optional validation fixtures
.swarm/skills/rejected-edits.jsonl          # FIFO buffer for rejected candidates
.opencode/skills/generated/<slug>/SKILL.md  # active generated skills
```

Generated files include the marker

```
<!-- generated by opencode-swarm skill-generator. ... -->
```

`skill_apply` will refuse to overwrite an active SKILL.md that lacks this
marker (i.e. one a human authored or modified) unless `force=true` is passed.

Generated frontmatter includes `triggers:` when source knowledge provided
trigger phrases. The propagation scorer treats those phrases as bounded literal
hints, so a task such as "fix the biome lint config" can surface a skill whose
frontmatter includes `triggers: ["biome", "lint config"]`.

### High-priority directive maturity path

Entries with `directive_priority: critical` or `directive_priority: high` are eligible
for a fast-track maturity path (added in issue #1477):

- Minimum **1 distinct phase confirmation** (not the standard 2), AND
- Confidence ≥ **0.60** (`HIGH_PRIORITY_SKILL_MIN_CONFIDENCE`, vs. the standard 0.70 floor)

Without this path, a `critical` entry that was only auto-generated (1 phase, 0.6 confidence)
would fail the standard gate on both dimensions simultaneously — the 0.7 confidence floor
AND the 2-phase confirmation requirement — making it impossible to mature regardless of
how valuable the directive is.

Net-negative outcome signal (`computeOutcomeSignal < 0`) still blocks even high-priority
entries. The standard gate for `medium`/`low` entries is unchanged.

### Validation fixtures

Optional eval fixtures under `.swarm/skills/evals/<slug>/*.json` gate generated
skill changes when callers pass `evaluate=true`. Each fixture can be a single
case, an array, or `{ "cases": [...] }`; cases support
`required_phrases` and `forbidden_phrases`.

When no eval set exists, the gate fails open and reports `unevaluated`. When an
incumbent active skill exists, the candidate must strictly improve the incumbent
before `skill_apply`, active `skill_generate`, `skill_regenerate`, or automatic
skill revision writes anything. Rejected candidates are recorded in the bounded
`.swarm/skills/rejected-edits.jsonl` buffer.

### Curator integration

When `curator.skill_generation_enabled` is true (default), the curator's
phase analysis can emit `skill_candidates` and `knowledge_application_findings`
JSON blocks that are parsed strictly. Malformed JSON is skipped without writes
and reported through debug-gated curator diagnostics.
High-confidence candidates (>= `curator.min_skill_confidence`) trigger
`skill_generate` in **draft** mode; activation always requires a human or
architect to call `skill_apply`.

### Maturity gate

An entry passes the maturity gate according to the following decision logic:

1. **Negative outcome signal** — Entries with `computeOutcomeSignal < 0` are rejected regardless of confirmations or confidence.
2. **Strong outcome bypass** — entries with a strong outcome record (`applied_explicit_count >= 3` or `succeeded_after_shown_count >= 3`) and a strictly positive outcome signal (`computeOutcomeSignal > 0`) bypass all remaining gates and are accepted regardless of confidence or confirmation count. Negative signals are still rejected by step 1 regardless of outcome record strength.
3. **Legacy AND gates** — for entries that reach this step, confidence must be >= `min_skill_confidence` (unless a strong outcome record is present, which bypasses the confidence floor), and either distinct phases >= `min_skill_confirmations` or a strong outcome record is present. When no strong outcome record is present, both conditions must hold independently; neither alone is sufficient.

**Configuration keys** (under `curator` config):
- `min_skill_confidence`: Confidence floor for candidates (default `0.70`). Configurable via config schema.
- `min_skill_confirmations`: Minimum distinct phases required for non-strong entries (default `2`). Configurable via config schema.

**Singleton promotion** — After the maturity gate above, 1-entry clusters are evaluated for promotion by `isSkillSingletonEligible` during clustering. A singleton passes this post-maturity check if it is a high/critical priority directive **or** has a strong outcome record (`applied/succeeded >= 3`). This allows well-evidenced singletons to become skills even when they haven't accumulated multiple confirmations yet.

See [Generated Skills](skills.md) for the generated-skill lifecycle and file
layout.

---

## Skill improver agent (issue #629)

The `skill_improver` agent runs rare, high-capability reviews of accumulated
knowledge / skills / spec / architect prompt under a hard daily quota.

When invoked the `skill_improve` tool dispatches the registered
`skill_improver` agent on an ephemeral OpenCode session (same pattern as
the curator LLM delegate). The agent's prompt requires it to emit a markdown
proposal with sections: Inventory snapshot, Repeated ignored or violated
directives, Concrete recommendations, Optional cluster suggestions, Risks.

```jsonc
"skill_improver": {
  "enabled": false,
  "max_calls_per_day": 10,
  "trigger": "manual",
  "consolidation_interval_hours": 24,
  "consolidation_max_calls_per_run": 1,
  "targets": ["skills", "spec", "architect_prompt", "knowledge"],
  "write_mode": "proposal",       // 'proposal' (no source mutation) | 'draft_skills'
  "require_user_approval": true,
  "quota_window": "utc",          // 'utc' (default) | 'local'
  "allow_deterministic_fallback": true
}
```

Set the **agent model** under `agents.skill_improver.model` (or
`swarms.<id>.agents.skill_improver.model` for multi-swarm). The legacy
top-level `skill_improver.model` field is **deprecated** and no longer drives
the agent — use the standard `agents.<name>.model` precedence instead. (See
the Configuration precedence section for details.)

### Output source tagging

Every proposal carries a YAML frontmatter line `source: llm` or
`source: deterministic_fallback` so reviewers can immediately tell which path
produced it:

| `source` | When | Quality |
|----------|------|---------|
| `llm` | The OpenCode client was wired AND the configured `skill_improver` agent responded | Real LLM analysis |
| `deterministic_fallback` | No client wired AND `allow_deterministic_fallback: true` (default for one minor — will flip to false in the next release) | Inventory-only summary; ⚠ NOT an LLM analysis |

Set `allow_deterministic_fallback: false` to refuse with `no_llm_client` when
no delegate is available.

### Quota policy

Skill-improver proposal quota state lives at `.swarm/skill-improver-quota.json`:

```json
{
  "date": "2026-05-08",
  "calls_used": 3,
  "max_calls": 10,
  "last_run_at": "2026-05-08T15:42:11Z",
  "window": "utc"
}
```

- Quota reservation runs under a `proper-lockfile` so parallel
  `skill_improve` invocations cannot lost-update each other.
- Knowledge enrichment uses a separate `.swarm/knowledge-enrichment-quota.json`
  file, governed by `knowledge.enrichment.*`, so curator/close-time/hardening
  LLM attempts do not consume the skill-improver proposal budget.
- **No-client + fallback-disabled** → refuse pre-flight; quota untouched.
- **Inventory failure (pre-network)** → release the reservation.
- **LLM call started** → slot stays consumed even on failure (anti-flake
  policy: a flaky model must not be allowed to burn unbounded retries
  within a window).

### How this closes #629

- The improver is a separately-registered agent (`skill_improver`)
  dispatched via the same ephemeral-session-per-call pattern as curator —
  see `src/hooks/skill-improver-llm-factory.ts`.
- Its model is independently configurable under `agents.skill_improver`,
  typically a more expensive OpenRouter model than the Architect's.
- Architect's prompt tells it to suggest `skill_improve` only after repeated
  failures, many ignored directives, or stale skills, and to ask the user
  before invoking when `require_user_approval` is true.
- Daily-quota enforcement caps cost — typically `max_calls_per_day: 10`.
- Default `write_mode: "proposal"` means the agent produces
  `.swarm/skill-improver/proposals/<timestamp>.md` only. With
  `write_mode: "draft_skills"` it additionally drafts SKILL.md proposals via
  the `skill_generate` pipeline (still draft mode — never auto-activated).

- Set `trigger: "scheduled"` to allow opportunistic consolidation on startup
  and phase completion. The scheduler is cadence-gated by
  `consolidation_interval_hours`, reserves at most
  `consolidation_max_calls_per_run` calls per run, validates drafted skills
  against matching eval fixtures, and never auto-activates proposals. Use
  `/swarm consolidate` for an explicit manual pass.

> **CI verification limitation.** The real-LLM dispatch path requires an
> OpenCode runtime to wire `swarmState.opencodeClient`. Unit and integration
> tests inject a mocked delegate and assert the dispatch shape. End-to-end
> verification with a live model requires a manual smoke run.

---

## Spec writer agent

`spec_writer` is an independently-modelled agent for authoring `.swarm/spec.md`.
It can run on a higher-capability model than Architect.

```jsonc
"spec_writer": {
  "enabled": true,
  "allow_spec_write": true       // gate for the safe spec_write tool
}
```

Set the agent model under `agents.spec_writer.model` (or
`swarms.<id>.agents.spec_writer.model`). The legacy top-level
`spec_writer.model` field is **deprecated** and no longer drives the agent.

The agent has read-only access to the codebase plus the safe `spec_write` tool
which atomically writes `.swarm/spec.md` (256 KiB cap, must contain a top-level
`# Heading`). It cannot edit source files.

The Architect prompt routes substantial spec authoring or revision to
`spec_writer` while keeping itself on a cheaper model.

---

## Configuration precedence

The model used by an agent is resolved in this order (highest priority first):

1. `agents.<name>.model` (root-level agent override) and
   `swarms.<id>.agents.<name>.model` (per-swarm override).
2. `DEFAULT_MODELS.<name>` (built-in default in `src/config/constants.ts`).

For new v2 agents:

| Agent | Where to set model | Where it WAS / now-deprecated |
|-------|-------------------|-------------------------------|
| `skill_improver` | `agents.skill_improver.model` | top-level `skill_improver.model` (deprecated, no effect) |
| `spec_writer` | `agents.spec_writer.model` | top-level `spec_writer.model` (deprecated, no effect) |

The deprecated top-level `model` fields remain in the schema only so that
config-doctor can warn when they are present without an `agents.<name>.model`
counterpart. They will be removed in a future major release.
