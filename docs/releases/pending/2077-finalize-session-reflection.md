**Finalize session reflection — knowledge_add actionability and persistence**

- `assembleActionMenu` now populates `required_actions`, `applies_to_agents`,
  and `verification_checks` on `knowledge_add` menu items so that `--apply`
  writes actionable entries instead of quarantining them for missing metadata.
- `handleApplyFlag` extracts actionability fields from menu item `data` and
  forwards them to `applyKnowledgeEntry`.
- Fixed misleading comment at `close.ts` that described `--apply` as
  "read-only" — the `knowledge_add` path does write to `knowledge.jsonl`.
- Added happy-path test proving knowledge entries persist via `--apply`.

Closes #2077.
