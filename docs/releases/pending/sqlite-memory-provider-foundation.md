---
title: SQLite memory provider foundation
category: added
---

## Summary

Adds the SQLite memory provider behind the existing memory gateway/provider seam.

## Details

- Added `memory.provider: "sqlite"` with `memory.sqlite.path` and `memory.sqlite.busyTimeoutMs` settings.
- Added SQLite provider parity for memory items, proposals, recall usage, and provider events under `.swarm/memory/memory.db`.
- Kept the Bun SQLite driver lazily resolved when the SQLite provider initializes so the Node-compatible plugin bundle remains loadable when SQLite is not selected.

## Migration

SQLite is now the default memory provider. Existing JSONL storage is migrated by the SQLite default migration described in the companion pending release fragment.
