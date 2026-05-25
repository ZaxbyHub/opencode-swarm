# SQLite default memory backend with JSONL migration

Changes the Swarm memory provider default to SQLite at `.swarm/memory/memory.db` while keeping `local-jsonl` available for legacy/debug mode.

Existing `.swarm/memory/memories.jsonl` and `.swarm/memory/proposals.jsonl` files are imported into SQLite once, backed up under `.swarm/memory/backups/`, and tracked by the `legacy_jsonl_import_complete` `schema_migrations` marker. Invalid JSONL rows are reported in `.swarm/memory/migration-report.json`.

Adds `/swarm memory status`, `/swarm memory export`, `/swarm memory import`, and `/swarm memory migrate` for inspecting storage, exporting JSONL, and running manual migration/recovery workflows.
