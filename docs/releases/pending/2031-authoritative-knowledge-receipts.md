# Authoritative project-local knowledge receipts

## What

- Separates correctness-critical retrieval membership and terminal receipts
  into a canonical-project-root V2 journal with a crash-safe snapshot and
  closed-summary archive.
- Commits the exact final displayed directive set before exposure and commits
  terminal state atomically before gates, promotion, or curation can accept it.
- Keeps linked/global knowledge diagnostics from redirecting or satisfying a
  project's receipt authority.
- Adds `knowledge.receipt_close_grace_days` (default `7`, range `0`-`3650`) for
  retaining resolved membership after durable phase closure.

## Why

`knowledge-events.jsonl` mixed receipts with high-volume diagnostics under one
5,000-row FIFO. Diagnostic churn could evict a live retrieval, reject an honest
receipt as `trace_not_found`, starve promotion evidence, and incorrectly remove
a critical phase obligation. Correctness no longer depends on that diagnostic
budget.

## Migration

No manual action is required. Cutover runs lazily on the first V2 receipt
operation and imports only complete, live records from the canonical project's
local legacy log. Missing, evicted, linked, malformed, or partial legacy state
is preserved as typed `legacy_unverifiable` uncertainty rather than inferred.

## Caveats

- `knowledge-events.jsonl` remains available as a bounded diagnostic stream but
  is no longer authoritative for receipts or gates.
- Receipt files never follow a knowledge link or hive/cohort configuration.
- Outcome and source normalization is intentionally unchanged; issue #2032
  owns those semantics, and V2 records `unknown` only when no source is present.
