# Generated Skills

Generated skills turn mature knowledge entries into reviewable `SKILL.md`
files that agents can load through the normal skill system.

## Lifecycle

1. Knowledge starts as swarm or hive entries in the knowledge store.
2. Event-sourced feedback records whether the entry was shown, acknowledged,
   applied, ignored, violated, or followed by a successful phase.
3. `skill_generate` and `skill_improve` select candidates using confirmations
   plus effective outcome rollups. Strong positive outcomes can mature a
   singleton; clearly negative outcome signal blocks compilation.
4. Drafts are written under `.swarm/skills/proposals/`.
5. `skill_apply` promotes a reviewed draft to
   `.opencode/skills/generated/<slug>/SKILL.md`.

Scheduled consolidation never activates generated skills automatically. A human
or architect must review and apply staged drafts from that path.

Generated frontmatter carries the same trigger phrases that matured the source
knowledge:

```yaml
---
name: biome-lint
description: Fix lint config
triggers:
  - biome
  - lint config
---
```

The skill scorer treats `triggers` as bounded literal hints. A task that contains
a trigger phrase receives a relevance boost, while short phrases are ignored so
generic tokens do not dominate ranking.

## File Layout

```text
.swarm/skills/proposals/<slug>.md
.swarm/skills/evals/<slug>/*.json
.swarm/skills/rejected-edits.jsonl
.opencode/skills/generated/<slug>/SKILL.md
```

Active generated skills include a generator marker comment. `skill_apply`
refuses to overwrite an active skill that lacks that marker unless `force=true`
is passed.

## Validation Evals

Place optional deterministic eval fixtures under
`.swarm/skills/evals/<slug>/*.json`. A fixture can be a single case, an array,
or `{ "cases": [...] }`:

```json
{
  "required_phrases": ["call declare_scope"],
  "forbidden_phrases": ["skip scope declaration"]
}
```

When `evaluate=true` is passed to `skill_generate`, `skill_apply`,
`skill_regenerate`, or `skill_improve` in `draft_skills` mode, candidate content
is checked before any file write, knowledge stamp, proposal deletion, or
changelog append. Missing eval fixtures fail open and report `unevaluated`.
Scheduled consolidation uses this validation path for drafted skills by default.
Existing active skills require a strict improvement over the incumbent. Rejected
candidates are recorded in `.swarm/skills/rejected-edits.jsonl`.

## Review Checklist

- Confirm the source knowledge IDs still match the intended behavior.
- Check that required and forbidden actions are concrete enough for an agent to
  follow.
- Remove stale project-specific references before applying a cross-project
  skill.
- Prefer a narrow skill over broad procedural advice when only one workflow is
  supported by evidence.

## Related Docs

- [Knowledge System](knowledge.md) - storage, lifecycle, scoring, and curation
- [Writing Tests Skill](../.opencode/skills/writing-tests/SKILL.md) - test
  authoring rules for generated-skill changes
