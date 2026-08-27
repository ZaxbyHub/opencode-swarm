# Trustworthy SymbolEdge v2 graph facts

Repo-graph symbol edges now carry deterministic endpoint and edge IDs,
relationship kind, advisory confidence, resolution provenance, and bounded
hashed source evidence. `graph_health` reports low-confidence and unresolved v2
facts without blocking traversal.

Existing schema 1.2.0 four-field edges remain readable and usable by
`context_pack`. They are normalized conservatively and reported as unscored
until the graph is rebuilt; malformed or semantically inconsistent v2 records
are rejected on both load and save.

No migration step is required. Rebuild with `repo_map action="build"` to populate
v2 metadata for an existing repository graph. This change is additive and has no
breaking configuration changes or known caveats beyond the documented
best-effort limits of static symbol extraction.
