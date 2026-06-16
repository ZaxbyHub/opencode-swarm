## Generated skill provenance metadata backfill

Backfilled YAML frontmatter provenance on 8 active generated skills:

- `ci-fix-monitor`
- `git-revert-safety`
- `mock-to-internals-migration`
- `opt-in-tool-registration`
- `parallel-work-check`
- `pr-readiness`
- `safe-extraction`
- `safe-rename`

Each skill now carries `generated_at`, `source_knowledge_ids`, `status`,
`version`, `skill_origin`, `confidence`, and a `provenance_note` explaining that
original source knowledge IDs could not be recovered. Restored original body
content for `ci-fix-monitor`, `git-revert-safety`, and `opt-in-tool-registration`
after an earlier `skill_regenerate` run replaced them with stubs. Removed the
stale proposal file `.swarm/skills/proposals/ci-fix-monitor.md` that had been
promoted to an active skill.

Also fixed two small skill-body issues surfaced during review:

- `ci-fix-monitor`: corrected a malformed 3-column table separator on a 2-column table.
- `pr-readiness`: corrected the `dist/` rebuild advice to state explicitly that
  `dist/` is generated output and must not be committed.

No source code, tool registration, or runtime behavior changed.

## Migration

No migration required. Skill consumers (agent delegations) reference the same
file paths; only frontmatter and a few body corrections changed.

## Known caveats

- `source_knowledge_ids` is empty for the backfilled skills because the original
  IDs were not recoverable from the knowledge base. Future skill_regenerate runs
  will populate these if the source knowledge entries still exist.
