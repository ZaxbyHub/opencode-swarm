# Documentation current-status refresh

## What changed

- Updated public documentation to reflect the current package metadata, command registry, cache layouts, SQLite-default memory provider, and `.swarm/` containment guidance.
- Replaced stale hardcoded command counts with source-of-truth wording that points readers to `src/commands/registry.ts`.
- Corrected General Council documentation so it describes the fixed three-agent council and deprecated compatibility fields accurately.

## Why

Several docs still described older v6-era behavior, old command counts, legacy JSONL-first memory, and unsafe `.swarm/` commit/reset guidance. This refresh keeps the docs easier to read for humans and less likely to mislead LLM agents.

## Migration steps

No migration is required.

## Breaking changes

None.

## Known caveats

This is a documentation-only refresh. Historical release-note files remain historical and were not rewritten.
