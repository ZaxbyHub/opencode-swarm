# Generated Skill Staleness Metadata

## What changed
- Generated SKILL.md frontmatter now includes:
  - `source_knowledge_ids` (array of source entry IDs)
  - `generated_at` (ISO timestamp at generation time)
- `skill_regenerate` rewrites generated skills with refreshed `source_knowledge_ids` and `generated_at`.
- `skill_improver` now reads generated skill frontmatter metadata and flags stale active skills when metadata is missing/invalid, sources are missing, or source entries were updated after generation.

## Why
This adds a lightweight provenance signal so staleness can be detected from frontmatter metadata instead of requiring full skill-content analysis.
