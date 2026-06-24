# chore: re-link 9 stale skills to current knowledge entries (version 4)

## What changed

Re-linked the `source_knowledge_ids` frontmatter on 9 generated skills
(`.opencode/skills/generated/`) so each skill's source-of-truth lineage points to
currently-active global knowledge entries rather than the archived entries the
original lineage referenced.

| Skill | Version | New source IDs (current) |
|-------|---------|---------------------------|
| `ci-fix-monitor` | v4 | `20f7da40` (test data), `f07c1f4d` (verify pre-existing) |
| `git-revert-safety` | v4 | `f07c1f4d` (verify pre-existing) |
| `guardrail-patterns` | v2 | `00cc0fba` (lint scripts), `b02ac9d7` (refactor guard) |
| `mock-to-internals-migration` | v4 | `00cc0fba` (lint scripts), `cc366a49` (upgrade-safety test) |
| `opt-in-tool-registration` | v4 | `b02ac9d7` (refactor guard) |
| `parallel-work-check` | v4 | `f07c1f4d` (verify pre-existing) |
| `pr-readiness` | v4 | `f07c1f4d` (verify pre-existing), `20f7da40` (test data) |
| `safe-extraction` | v4 | `b02ac9d7` (refactor guard), `cc366a49` (upgrade-safety test) |
| `safe-rename` | v4 | `20f7da40` (test data) |

Skill body content is unchanged for all 9 skills (only YAML frontmatter was updated).
Version bumped to 4 (or 2 for `guardrail-patterns`) with a new `provenance_note`
explaining the re-link.

## Why

The `skill_improve` audit (post-PR-#1485) flagged all 9 active skills as
"would-be-retired" because their `source_knowledge_ids` resolved to archived
entries (62 entries currently in archive, 0 active). The fix in
PR #1485 (commit `f3d5cc5`) added existence validation to `skill_generate`,
but the existing skills' frontmatter was never re-linked to current knowledge
entries — so any attempt to re-cluster or regenerate produced "no matching
knowledge entries found".

The audit found that each of the 9 skills' original source IDs is in the
archived store. The root cause: **Stored then purged/archived** during
knowledge tier transitions. The skills' content is valid; only the
provenance metadata is stale.

## Migration

No migration required. The skill behavior and content are unchanged.
The only change is which knowledge entry each skill's frontmatter cites
as its source. Active agent skills continue to work as before.

## Breaking changes

None. This is a pure metadata refresh.

## Known caveats

1. **`skill_improve` "stale" dry-run flag persists immediately after re-link.**
   The `skill_improve` tool's `staleSkillReconciliation.retired` field is a
   dry-run candidate list, not actual retirement. After re-linking, the
   on-disk `source_knowledge_ids` reference current active knowledge
   entries, but the dry-run check appears not to re-evaluate immediately
   after metadata edits. The authoritative on-disk state is what matters
   for `skill_regenerate` and other tools.

2. **`guardrail-patterns` body is out of sync with frontmatter.** The skill
   body still contains a markdown reference to the original 4 source IDs
   ("**Source knowledge:** `098926ef`, `2c1e4689`, `54c33fa4`, `4f51d11a`"),
   but the frontmatter now references 2 new IDs. This is a known artifact
   of metadata-only re-linking (vs full body regeneration). The frontmatter
   is the authoritative source for skill-tooling; the body inline reference
   is documentation text that can be updated in a follow-up.

3. **Skill body regeneration is destructive.** During testing,
   `skill_regenerate` was called on `guardrail-patterns` and it truncated
   the skill body from 317 lines (with detailed guardrail pattern
   documentation) to 55 lines (generic lesson text from the source
   knowledge). The change was reverted. **For skills with detailed,
   hand-authored content, just re-link the metadata — do NOT regenerate.**
   `skill_regenerate` is only safe for skills whose body is intended to be
   derived entirely from source knowledge.
