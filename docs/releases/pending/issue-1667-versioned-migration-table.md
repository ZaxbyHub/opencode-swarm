Extends \/swarm config doctor\ with a versioned deprecated-field migration table and pairs it with the existing version-check staleness warning.

### What changed
- Added \config_format_version\ (non-negative integer, default 1) to \PluginConfigSchema\ — distinct from \knowledge.schema_version\
- Versioned \DEPRECATED_FIELDS\ entries with \deprecatedIn\/\sinceVersion\ integers on the same axis as \config_format_version\
- Added migration-availability detection in \unConfigDoctor\: compares \config_format_version < deprecatedIn\
- Renders \Migrations Available\ section in \/swarm config doctor\ output when the loaded config predates deprecations
- \ersion-check.ts\ staleness message now references \/swarm config doctor\ for config-migration inspection
- \shouldRunOnStartup\ is unchanged (explicitly out of scope per the issue)

### Why
Users running an older config file never learned that cleaner, non-deprecated alternatives exist because \DEPRECATED_FIELDS\ had no version anchors and the version-check warning only mentioned \unx opencode-swarm update\.

### Migration
No migration required. \config_format_version\ defaults to 1 when absent.