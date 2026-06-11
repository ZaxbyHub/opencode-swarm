# Learning Observability and Violation-Informed Skill Revision

## What changed

### Part 1: Learning Observability — `/swarm learning` command

New `/swarm learning` command that computes aggregate metrics from `.swarm/knowledge-events.jsonl` and the knowledge store:

- **Violation-rate trends** — per-directive violation rates over 7-day and 30-day windows with trend direction (improving/worsening/stable)
- **Application rates by priority** — how often directives are applied when shown, grouped by priority level
- **Escalation activity** — auto-escalation frequency over recent windows
- **Entry ROI** — per-entry applied/shown/succeeded/failed counts with ROI classification (high/medium/low/unused)
- **Never-applied entries** — directives alive for N+ phases but never applied
- **Time to first application** — median/min/max days from directive creation to first application
- **Learning summary** — 3-line summary auto-injected into curator phase digest after each phase

Flags:
- `--json` — output metrics as structured JSON in a `[LEARNING_JSON]...[/LEARNING_JSON]` envelope
- `--phase N` — set the current phase number for never-applied threshold calculations

### Part 2: Skill Improvement Loop — Violation-Informed Revision + Versioning

**Curator step 8b (skill revision):** When a skill's violation rate crosses 15% (but stays ≤30%), the curator revises it automatically before the auto-retire step. Revision works in two paths:

1. **Deterministic path** (no LLM delegate): appends a `## Revision Notes` section with violation contexts before `## Source Knowledge IDs`, updates the version field in frontmatter.
2. **LLM-based path** (with delegate): sends violation contexts to the LLM for a bounded rewrite of violated sections, validates the output, and enforces the correct version field.

**Promoted-external skills are skipped** from revision and auto-retire to preserve external skill integrity.

**Revised skills are excluded from auto-retire** in the same phase to allow the revision to take effect.

**Per-skill changelog:** Every skill now has an append-only JSONL changelog at `.swarm/skill-changelogs/<slug>.jsonl` tracking every regeneration and revision with version numbers, timestamps, and triggering contexts. FIFO trim at 200 entries per skill.

**Version stamping:** Every SKILL.md now carries:
- `version: <number>` in frontmatter (auto-incremented on regeneration or revision; defaults to 1 for existing skills)
- `skill_origin: generated | promoted_external` (defaults to `generated` for backward compat; set to `promoted_external` for external skills)

**Skill usage tracking:** Each skill-usage log entry now optionally records the skill version at the time of the usage event, enabling per-version compliance tracking via `computeComplianceByVersion()`.

## Why

Revisiting the issue #1234 scope:

1. **Observability** — Operations needed visibility into how well directives are working in practice. Violation trends reveal which lessons are not sticking; never-applied entries reveal which knowledge remains dead-weight; ROI estimates reveal which directives should be retired or promoted.

2. **Skill improvement loop closure** — Directives were generated, followed, violated, and then either ignored or auto-retired. There was no step to improve them based on violation feedback. The revision step creates the feedback loop: generate → use → violate → revise → re-use, with a soft threshold (15%) preventing hyperactive revisions while catching genuinely broken lessons early.

3. **Promoted skills stability** — External skills need to remain stable to maintain trust with their publishers. Version stamping and skill-origin tracking distinguish promoted external skills (never auto-revise, never auto-retire) from generated skills (may revise or retire).

## Migration

No migration required. Existing SKILL.md files without `version` or `skill_origin` fields are supported:
- Missing `version` defaults to 1 during parsing
- Missing `skill_origin` defaults to `'generated'`
- First regeneration or revision will stamp the missing fields into frontmatter

The learning command works on existing `.swarm/knowledge-events.jsonl` files with no preprocessing.

## Known caveats

- The `/swarm learning` command is lightweight and does not trigger expensive aggregations; it samples the past 7 and 30 days of events.
- The revision step is capped to 3 LLM calls per curator phase to avoid quota starvation of manual skill-improve runs.
- LLM revision relies on LLM compliance with the version field update instruction; the code force-overwrites the version in the output to ensure consistency.
- Never-applied detection uses `phases_alive` from the knowledge store; entries without this field are ignored.
