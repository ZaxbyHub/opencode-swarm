## Issue #1508: Skills stale.marker infrastructure

### What changed
- Added physical `stale.marker` file (matching `retired.marker` pattern) to mark derived skills as stale when source knowledge entries are archived or deleted
- Post-archive hook in `knowledge-archive.ts`: fires `queueMicrotask` after tombstone write, calls `findSkillsBySourceKnowledgeId`, uses `retireOrMarkStale` to decide stale vs retired, emits `skill-stale-batch` event
- Post-purge hook in `knowledge-remove.ts`: same pattern for hard-deleted entries
- `retireOrMarkStale` shared helper: decides retire (all sources archived) vs stale (partial) based on whether all source knowledge IDs are in the archived set
- `markSkillStale` / `clearSkillStale` helpers: write/remove `stale.marker` file in skill directory
- `listSkills()` updated: stale skills excluded from `active[]`, appear in new `stale[]` array with reason
- `skill-propagation-gate.ts`: stale skills excluded from injection (alongside retired.marker)
- `skill_inspect`: new `source_knowledge_status[]` and `stale_reason` fields
- `run_stale_reconciliation` tool: scans skills, parses `source_knowledge_ids`, reconciles against knowledge store, marks stale or clears
- 40 new unit tests across 7 test files

### Why
Archived knowledge entries should invalidate derived skills. Without this, stale skills continue to be injected into agent prompts even though their source knowledge is no longer active.

### Migration steps
No migration required — purely internal infrastructure change.

### Breaking changes
None.
