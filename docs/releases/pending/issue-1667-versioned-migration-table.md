Extends `/swarm config doctor` with a versioned deprecated-field migration table and pairs it with the existing version-check staleness warning.

### What changed
- Added `config_format_version` (non-negative integer, default 1) to `PluginConfigSchema` — distinct from `knowledge.schema_version`.
- Versioned `DEPRECATED_FIELDS` entries with `deprecatedIn`/`sinceVersion` integers on the same axis as `config_format_version`.
- Added migration-availability detection in `runConfigDoctor`: compares `config_format_version < deprecatedIn`.
- `/swarm config doctor` now renders a "Migrations Available" section when the loaded config predates the deprecations, and `/swarm config doctor --fix` actually applies them (moving each legacy field's value to its replacement path and removing the legacy key).
- `version-check.ts` staleness message now references `/swarm config doctor` for config-migration inspection.
- `shouldRunOnStartup` is unchanged (explicitly out of scope per the issue).

### Why
Users running an older config file never learned that cleaner, non-deprecated alternatives exist because `DEPRECATED_FIELDS` had no version anchors and the version-check warning only mentioned `bunx opencode-swarm update`.

### Migration
No manual migration required. `config_format_version` defaults to 1 when absent. To adopt replacements for any deprecated field you've set, run `/swarm config doctor --fix`.
