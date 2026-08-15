# Docs: knowledge Entry Schema example aligned with current category/status unions

## What changed

- The Entry Schema example in `docs/knowledge.md` now uses category `"architecture"` and status `"established"` — both members of the current unions in `src/hooks/knowledge-types.ts` — instead of the stale `"pattern"` / `"active"` values that no longer exist.
- The Migration section's stale legacy category mapping (lesson/pattern/domain/decision) and `docs/skills.md`'s stale 5-value category list are aligned with the current 10-member `KnowledgeCategory` union.
- New drift-guard test `tests/unit/hooks/knowledge-docs-schema-example.test.ts` parses both unions from `knowledge-types.ts` (single source of truth) and validates the JSON example, doc-wide category literals (excluding immutable releases/archive), and the skills.md enumeration.

## Why

Generated agents copying the documented example would write entries with invalid category/status values (issue #1662's sibling docs drift, filed as #1611). The docs and the type unions had silently diverged.

## Migration steps

None. Docs and test files only; no runtime code touched.

## Known caveats

- Doc-wide `status` scanning is limited to knowledge.md's Entry Schema example — the sole knowledge-status example in current docs. Release notes and `docs/archive/` are immutable history and intentionally excluded.
