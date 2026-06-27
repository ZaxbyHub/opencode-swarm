# repo-graph: repository memory contract

## What

- Added `docs/repo-memory-graph-plan.md`, a design contract for the ordered
  graph-memory PR series.
- Documented the required OS matrix, 12-language support matrix, graph fact
  confidence levels, output fields, source-grounded context packs,
  graph-first/search-fallback retrieval, backward compatibility policy, release
  criteria, and glossary.
- Linked the new contract from the existing schema 1.2.0 symbol-graph doc.

## Why

Issue #1522 establishes the contract for graph-backed repository memory before
later PRs expand graph extraction or agent behavior. The contract gives future
work one acceptance standard for provenance, freshness, truncation, confidence,
warnings, compatibility, and cross-platform support.

## Migration

No runtime migration. Existing `.swarm/repo-graph.json` files and `repo_map`
behavior are unchanged by this docs-only PR.

## Caveats

- This PR does not implement new graph extraction behavior.
- SQLite, embeddings, external analyzers, and agent behavior changes remain out
  of scope until later graph-memory slices satisfy the documented contract.
