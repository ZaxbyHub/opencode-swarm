# Surface missing source knowledge IDs in skill frontmatter

## What changed

`skill_generate` now surfaces missing knowledge IDs at compile time instead of silently dropping them:

- `stampSourceEntries` was refactored to return `{ stamped, missing }` instead of `void`. The `missing` array tracks which source knowledge IDs were not found in swarm OR hive knowledge.
- Active-mode compile (`req.mode === 'active'`) captures `missing` from `stampSourceEntries`, and if non-empty calls a new private helper `injectMissingIdsIntoFrontmatter` to add a `missing_source_knowledge_ids:` block to the skill YAML frontmatter immediately after `source_knowledge_ids:`.
- `GenerateResult.written[i].missingSourceKnowledgeIds?: string[]` was added so programmatic callers receive the missing IDs in the result object.
- `GenerateResult.written[i]` ordering is now: stamp source entries BEFORE writing the skill file (previously: write first, then stamp). This ensures the frontmatter reflects the final state.

## Why

Addresses recommendation 2 from the `skill_improver` proposal: previously, `stampSourceEntries` silently skipped source knowledge IDs that didn't exist in the knowledge store, causing skills to become stale with no visible warning. Active-mode skills now show missing IDs in their frontmatter at compile time so staleness is visible immediately, not deferred to `skill_improver` review time.

Before: a skill compiled with 3 source IDs where 1 was archived → skill stamped, no warning, staleness detected only at `skill_improver` review time.

After: same scenario → skill compiled, `missing_source_knowledge_ids: [archived-id]` written to frontmatter, `missingSourceKnowledgeIds` populated in the result object.

## Migration

No migration required. Existing skills are unaffected; only newly generated active-mode skills will include the new `missing_source_knowledge_ids` frontmatter block when their source IDs include missing entries. Downstream parsers (e.g., `parseDraftFrontmatter`) already handle arbitrary frontmatter keys gracefully.

## Breaking changes

None.

## Known caveats

- The string-based YAML frontmatter manipulation in `injectMissingIdsIntoFrontmatter` handles the standard multi-line `source_knowledge_ids:` block emitted by `renderSkillMarkdown`. Inline flow-style (`source_knowledge_ids: [id1, id2]`) and unusual indentations are not handled, but those forms are never produced by the current `renderSkillMarkdown` output.
- Only UTF-8 BOM is stripped from the input content. UTF-16 files would fail YAML parsing upstream of this code path.
- The `stamped` return value may contain duplicates when an ID exists in both swarm and hive. This is cosmetic (no caller iterates `stamped`); both in-source callers destructure only `{ missing }`.
