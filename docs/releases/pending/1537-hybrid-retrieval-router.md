# Hybrid retrieval router for graph-first context selection

- Adds `repo_map action="retrieve"`, a deterministic and inspectable router for
  graph, exact lexical, semantic-intent/fuzzy, security, test, and hybrid code
  context requests.
- Reuses existing graph query packs programmatically and falls back to the
  bounded workspace literal-search engine when graph context is unavailable or
  has no relevant result.
- Returns strategy explanations, graph hit/miss and fallback reasons, and
  deterministic context-budget accounting.
- Records content-free `retrieval_routed` telemetry containing only closed mode
  and fallback labels, booleans, and counts—never query, source, path, symbol,
  or result content.
- Aligns the Node search fallback with ripgrep by skipping NUL-bearing binary
  files before UTF-8 decoding.
