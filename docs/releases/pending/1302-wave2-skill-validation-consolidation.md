# Knowledge system wave 2 skill validation and consolidation

Implemented generated-skill lifecycle hardening:

- generated skills now emit and score `triggers:` frontmatter
- optional `.swarm/skills/evals/<slug>/*.json` fixtures can validation-gate
  skill generation, activation, regeneration, and automatic revision
- rejected skill candidates are recorded in
  `.swarm/skills/rejected-edits.jsonl`
- `skill_improver.trigger: "scheduled"` now supports bounded startup and
  phase-complete consolidation, plus explicit `/swarm consolidate`
